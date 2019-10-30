/*
 *    Copyright 2017 Rethink Robotics
 *
 *    Copyright 2017 Chris Smith
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

"use strict";

const NetworkUtils = require('../../utils/network_utils.js');
const SerializationUtils = require('../../utils/serialization_utils.js');
const DeserializeStream = SerializationUtils.DeserializeStream;
const Deserialize =  SerializationUtils.Deserialize;
const Serialize = SerializationUtils.Serialize;
const TcprosUtils = require('../../utils/tcpros_utils.js');
const UdprosUtils = require('../../utils/udpros_utils.js');

const TCPSocket = require('net').Socket;
const UDPSocket = require('dgram');
const EventEmitter = require('events');
const Logging = require('../Logging.js');
const {REGISTERING, REGISTERED, SHUTDOWN} = require('../../utils/ClientStates.js');

const protocols = [['TCPROS']];

//-----------------------------------------------------------------------

/**
 * Implementation class for a Subscriber. Handles registration, connecting to
 * publishers, etc. Public-facing subscriber classes will be given an instance
 * of this to use
 */
class SubscriberImpl extends EventEmitter {

  constructor(options, nodeHandle) {
    super();
    console.log(options);
    this.count = 0;

    this._topic = options.topic;

    this._type = options.type;

    this._transport = options.transport

    if (options.hasOwnProperty('queueSize')) {
      this._queueSize = options.queueSize;
    }
    else {
      this._queueSize = 1;
    }

    /**
     * throttleMs interacts with queueSize to determine when to handle callbacks
     *  < 0  : handle immediately - no interaction with queue
     *  >= 0 : place event at end of event queue to handle after minimum delay (MS)
     */
    if (options.hasOwnProperty('throttleMs')) {
      this._throttleMs = options.throttleMs;
    }
    else {
      this._throttleMs = 0;
    }

    // tcpNoDelay will be set as a field in the connection header sent to the
    // relevant publisher - the publisher should then set tcpNoDelay on the socket
    this._tcpNoDelay =  !!options.tcpNoDelay;

    this._msgHandleTime = null;

    this._nodeHandle = nodeHandle;
    this._nodeHandle.getSpinner().addClient(this, this._getSpinnerId(), this._queueSize, this._throttleMs);

    this._log = Logging.getLogger('ros.rosnodejs');

    if (!options.typeClass) {
      throw new Error(`Unable to load message for subscriber ${this.getTopic()} with type ${this.getType()}`);
    }
    this._messageHandler = options.typeClass;
    console.log(new this._messageHandler());
    this._pubClients = {};

    this._pendingPubClients = {};

    this._state = REGISTERING;
    this._register();
  }

  /**
   * Uniquely identifies this subscriber to the node's Spinner
   * @returns {string}
   */
  _getSpinnerId() {
    return `Subscriber://${this.getTopic()}`;
  }

  /**
   * Get the name of the topic this subscriber is listening on
   * @returns {string}
   */
  getTopic() {
    return this._topic;
  }

  /**
   * Get the type of message this subscriber is handling
   *            (e.g. std_msgs/String)
   * @returns {string}
   */
  getType() {
    return this._type;
  }

  /**
   * Get count of the publishers currently connected to this subscriber
   * @returns {number}
   */
  getNumPublishers() {
    return Object.keys(this._pubClients).length;
  }

  /**
   * Get the ros node this subscriber belongs to
   * @returns {RosNode}
   */
  getNode() {
    return this._nodeHandle;
  }

  /**
   * Clears and closes all client connections for this subscriber.
   */
  shutdown() {
    this._state = SHUTDOWN;
    this._log.debug('Shutting down subscriber %s', this.getTopic());

    Object.keys(this._pubClients).forEach(this._disconnectClient.bind(this));
    Object.keys(this._pendingPubClients).forEach(this._disconnectClient.bind(this));

    // disconnect from the spinner in case we have any pending callbacks
    this._nodeHandle.getSpinner().disconnect(this._getSpinnerId());
    this._pubClients = {};
    this._pendingPubClients = {};
  }

  /**
   * @returns {boolean} true if this subscriber has been shutdown
   */
  isShutdown() {
    return this._state === SHUTDOWN;
  }

  /**
   * @returns {Array} URIs of all current clients
   */
  getClientUris() {
    return Object.keys(this._pubClients);
  }

  /**
   * Send a topic request to each of the publishers in the list.
   * Assumes we have NOT connected to them.
   * @param pubs {Array} array of uris of nodes that are publishing this topic
   */
  requestTopicFromPubs(pubs) {
    console.log("requestTopicFromPubs",pubs)
    pubs.forEach((pubUri) => {
      pubUri = pubUri.trim();
      this._transport === 'TCPROS' ?
        this._requestTcpTopicFromPublisher(pubUri) :
        this._requestUdpTopicFromPublisher(pubUri)
    });
  }

  /**
   * Handle an update from the ROS master with the list of current publishers. Connect to any new ones
   * and disconnect from any not included in the list.
   * @param publisherList {Array.string}
   * @private
   */
  _handlePublisherUpdate(publisherList) {
    const missingPublishers = new Set(Object.keys(this._pubClients));

    publisherList.forEach((pubUri) => {
      pubUri = pubUri.trim();
      if (!this._pubClients.hasOwnProperty(pubUri)) {
        this._requestTopicFromPublisher(pubUri);
      }

      missingPublishers.delete(pubUri);
    });

    missingPublishers.forEach((pubUri) => {
      this._disconnectClient(pubUri);
    });
  }

  /**
   * Sends a topicRequest XMLRPC message to the provided URI and initiates
   *  the topic connection if possible.
   * @param pubUri {string} URI of publisher to request a topic from
   */
  _requestUdpTopicFromPublisher(pubUri) {
    let info = NetworkUtils.getAddressAndPortFromUri(pubUri);
    // send a topic request to the publisher's node
    //this._log.debug('Sending topic request to ' + JSON.stringify(info));
    console.log('Sending topic request to ' + JSON.stringify(info));

    let callerId = this._nodeHandle.getNodeName()
    let md5sum = this._messageHandler.md5sum()
    let topic = this.getTopic()
    let msgType = this.getType()

    const socket = UDPSocket.createSocket('udp4');


    // cache client in "pending" map.
    // It's not validated yet so we don't want it to show up as a client.
    // Need to keep track of it in case we're shutdown before it can be validated.
    //this._pendingPubClients[socket.nodeUri] = socket;

    // create a one-time handler for the connection header
    // if the connection is validated, we'll listen for more events

    socket.on('error', (err) => {
      console.log(`server error:\n${err.stack}`);
      server.close();
    });

    socket.on('message', (msg, rinfo) => {

      //console.log(`server got msg from ${rinfo.address}:${rinfo.port}, length: ${msg.length - 20}`);
      let connectionId = msg.readUInt32LE(0)
      let opCode = msg.readUInt8(4)
      let msgId = msg.readUInt8(5)
      let blkN = msg.readUInt16LE(6)

      let msgLen = msg.readUInt32LE(8)

      let _msg = Buffer.from(msg.slice(12))


      let rosHseq = msg.readUInt32LE(12)
      let secs = msg.readUInt32LE(16)
      let nsecs = msg.readUInt32LE(20)
      let frameId = msg[24] // 0 no frame, 1 global frame

      /*console.log(`ConnectionId: ${connectionId},
        Opcode: ${opCode},
        Message Id:${msgId},
        Block number: ${blkN},
        Msg Len: ${msgLen},
        Hseq: ${rosHseq},
        secs: ${secs},
        nsecs: ${nsecs}
        frameId: ${frameId}`);
      */
      console.log('-------------------------UDP---------------------------');
      console.log(_msg)
      console.log('-------------------------/UDP---------------------------')


      console.log(this._messageHandler.deserialize(_msg))

      // cache client in "pending" map.
      // It's not validated yet so we don't want it to show up as a client.
      // Need to keep track of it in case we're shutdown before it can be validated.

    });

    socket.on('listening', () => {
      const address = socket.address();
      console.log(`server listening ${address.address}:${address.port}`);
    });


    socket.bind(41234);


    let header = UdprosUtils.createSubHeader(this._nodeHandle.getNodeName(), this._messageHandler.md5sum(), this.getTopic(), this.getType())
    //let buff = Buffer.alloc(16 + callerId.length + md5sum.length + topic.length + msgType.length +1).fill(0)
    //console.log(Buffer.from(callerId.length.toString(16), 'hex'))
    //console.log(Buffer.from(md5sum.length.toString(16), 'hex'))
    console.log(header)
    //console.log(Buffer.from(msgType.length.toString(16), 'hex'))
    /*
    let buff = Buffer.concat([
      Buffer.from(callerId.length.toString(16), 'hex'),
      padding,
      callerId,

      Buffer.from(md5sum.length.toString(16), 'hex'),
      padding,
      md5sum,

      Buffer.from('0'+topic.length.toString(16), 'hex'),
      padding,
      topic,

      Buffer.from(msgType.length.toString(16), 'hex'),
      padding,
      msgType,
    ])
    */
    //let buff1 = Buffer.from('HQAAAGNhbGxlcmlkPS9saXN0ZW5lcl91bnJlbGlhYmxlJwAAAG1kNXN1bT05OTJjZThhMTY4N2NlYzhjOGJkODgzZWM3M2NhNDFkMQ4AAAB0b3BpYz0vY2hhdHRlchQAAAB0eXBlPXN0ZF9tc2dzL1N0cmluZw==', 'base64')
    //let base64data = buff.toString('base64');
    //console.log(buff1)
    //this._nodeHandle.requestTopic(info.host, info.port, this._topic, protocols)
    this._nodeHandle.requestTopic(info.host, info.port, this._topic, [[this._transport, header, '127.0.0.1', 41234, 1500]])
      .then((resp) => {

        //this._handleTopicRequestResponse(resp, pubUri);
      })
      .catch((err, resp) => {
        // there was an error in the topic request
        //console.log("Error", err, resp)
        this._log.warn('Error requesting topic on %s: %s, %s', this.getTopic(), err, resp);
      });
  }
  _requestTcpTopicFromPublisher(pubUri) {
    let info = NetworkUtils.getAddressAndPortFromUri(pubUri);
    // send a topic request to the publisher's node
    this._log.debug('Sending topic request to ' + JSON.stringify(info));
    this._nodeHandle.requestTopic(info.host, info.port, this._topic, protocols)
      .then((resp) => {

        this._handleTopicRequestResponse(resp, pubUri);
      })
      .catch((err, resp) => {
        // there was an error in the topic request
        this._log.warn('Error requesting topic on %s: %s, %s', this.getTopic(), err, resp);
      });
  }
  /**
   * disconnects and clears out the specified client
   * @param clientId {string}
   */
  _disconnectClient(clientId) {
    let client = this._pubClients[clientId];

    const hasValidatedClient = !!client;
    if (!hasValidatedClient) {
      client = this._pendingPubClients[clientId];
    }

    if (client) {
      this._log.debug('Subscriber %s disconnecting client %s', this.getTopic(), clientId);
      client.end();

      client.removeAllListeners();
      client.$deserializer.removeAllListeners();

      client.$deserializer.end();
      client.unpipe(client.$deserializer);

      delete client.$deserializer;

      delete this._pubClients[clientId];
      delete this._pendingPubClients[clientId];

      if (hasValidatedClient) {
        this.emit('disconnect');
      }
    }
  }

  /**
   * Registers the subscriber with the ROS master
   * will connect to any existing publishers on the topic that are included in the response
   */
  _register() {
    this._nodeHandle.registerSubscriber(this._topic, this._type)
    .then((resp) => {
      // if we were shutdown between the starting the registration and now, bail
      if (this.isShutdown()) {
        return;
      }

      // else handle response from register subscriber call
      let code = resp[0];
      let msg = resp[1];
      let pubs = resp[2];
      if ( code === 1 ) {
        // success! update state to reflect that we're registered
        this._state = REGISTERED;

        if (pubs.length > 0) {
          // this means we're ok and that publishers already exist on this topic
          // we should connect to them
          this.requestTopicFromPubs(pubs);
        }
        this.emit('registered');
      }
    })
    .catch((err, resp) => {
      console.log('Error', err, resp)
      this._log.warn('Error during subscriber %s registration: %s', this.getTopic(), err);
    })
  }

  /**
   * Handles the response to a topicRequest message (to connect to a publisher)
   * @param resp {Array} xmlrpc response to a topic request
   */
  _handleTopicRequestResponse(resp, nodeUri) {
    if (this.isShutdown()) {
      return;
    }

    //this._log.debug('Topic request response: ' + JSON.stringify(resp));
    //console.log('Topic request response: ' + JSON.stringify(resp));

    // resp[2] has port and address for where to connect
    let info = resp[2];
    let port = info[2];
    let address = info[1];

    //console.log("_handleTopicRequestResponse, [info, port, address]: ", info, port, address)

    let socket = new TCPSocket();
    socket.name = address + ':' + port;
    socket.nodeUri = nodeUri;

    socket.on('end', () => {
      this._log.info('Subscriber client socket %s on topic %s ended the connection',
                     socket.name, this.getTopic());
    });

    socket.on('error', (err) => {
      this._log.warn('Subscriber client socket %s on topic %s had error: %s',
                     socket.name, this.getTopic(), err);
    });

    // hook into close event to clean things up
    socket.on('close', () => {
      this._log.info('Subscriber client socket %s on topic %s disconnected',
                     socket.name, this.getTopic());
      this._disconnectClient(socket.nodeUri);
    });

    // open the socket at the provided address, port
    socket.connect(port, address, () => {
      if (this.isShutdown()) {
        socket.end();
        return;
      }

      this._log.debug('Subscriber on ' + this.getTopic() + ' connected to publisher at ' + address + ':' + port);
      socket.write(this._createTcprosHandshake());
    });
    let deserializer = new DeserializeStream();
    socket.$deserializer = deserializer;
    socket.pipe(deserializer);

    // cache client in "pending" map.
    // It's not validated yet so we don't want it to show up as a client.
    // Need to keep track of it in case we're shutdown before it can be validated.
    this._pendingPubClients[socket.nodeUri] = socket;

    // create a one-time handler for the connection header
    // if the connection is validated, we'll listen for more events
    deserializer.once('message', this._handleConnectionHeader.bind(this, socket));
  }

  /**
   * Convenience function - creates the connection header for this subscriber to send
   * @returns {string}
   */
  _createTcprosHandshake() {
    return TcprosUtils.createSubHeader(this._nodeHandle.getNodeName(), this._messageHandler.md5sum(),
                                       this.getTopic(), this.getType(), this._messageHandler.messageDefinition(), this._tcpNoDelay);
  }

  /**
   * Handles the connection header from a publisher. If connection is validated,
   * we'll start handling messages from the client.
   * @param socket {Socket} publisher client who sent the connection header
   * @param msg {string} message received from the publisher
   */
  _handleConnectionHeader(socket, msg) {
    if (this.isShutdown()) {
      this._disconnectClient(socket.nodeUri);
      return;
    }

    let header = TcprosUtils.parseTcpRosHeader(msg);
    // check if the publisher had a problem with our connection header
    if (header.error) {
      this._log.error(header.error);
      return;
    }

    // now do our own validation of the publisher's header
    const error = TcprosUtils.validatePubHeader(header, this.getType(), this._messageHandler.md5sum());
    if (error) {
      this._log.error(`Unable to validate subscriber ${this.getTopic()} connection header ${JSON.stringify(header)}`);
      socket.end(Serialize(error));
      return;
    }
    // connection header was valid - we're good to go!
    this._log.debug('Subscriber ' + this.getTopic() + ' got connection header ' + JSON.stringify(header));

    // cache client now that we've verified the connection header
    this._pubClients[socket.nodeUri] = socket;
    // remove client from pending map now that it's validated
    delete this._pendingPubClients[socket.nodeUri];

    // pipe all future messages to _handleMessage
    socket.$deserializer.on('message', this._handleMessage.bind(this));

    this.emit('connection', header, socket.name);
  }

  /**
   * Handles a single message from a publisher. Passes message off to
   * Spinner if we're queueing, otherwise handles it immediately.
   * @param msg {string}
   */
  _handleMessage(msg) {
    console.log(msg)
    if (this._throttleMs < 0) {
      this._handleMsgQueue([msg]);
    }
    else {
      this._nodeHandle.getSpinner().ping(this._getSpinnerId(), msg);
    }
  }

  /**
   * Deserializes and events for the list of messages
   * @param msgQueue {Array} array of strings - each string is its own message.
   */
  _handleMsgQueue(msgQueue) {
    try {
      msgQueue.forEach((msg) => {
        this.emit('message', this._messageHandler.deserialize(msg));
      });
    }
    catch (err) {
      this._log.error('Error while dispatching message on topic %s: %s', this.getTopic(), err);
      this.emit('error', err);
    }
  }
}

//-----------------------------------------------------------------------

module.exports = SubscriberImpl;
