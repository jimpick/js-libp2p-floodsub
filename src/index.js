'use strict'

const TimeCache = require('time-cache')
const pull = require('pull-stream')
const lp = require('pull-length-prefixed')
const assert = require('assert')

const BaseProtocol = require('./base')
const utils = require('./utils')
const pb = require('./message')
const config = require('./config')

const multicodec = config.multicodec
const ensureArray = utils.ensureArray
const setImmediate = require('async/setImmediate')

/**
 * FloodSub (aka dumbsub is an implementation of pubsub focused on
 * delivering an API for Publish/Subscribe, but with no CastTree Forming
 * (it just floods the network).
 */
class FloodSub extends BaseProtocol {
  /**
   * @param {Object} libp2p
   * @returns {FloodSub}
   */
  constructor (libp2p) {
    super('libp2p:floodsub', multicodec, libp2p)

    /**
     * Time based cache for sequence numbers.
     *
     * @type {TimeCache}
     */
    this.cache = new TimeCache({defaultTtl: 60 * 60 * 1000}) // One hour

    /**
     * List of our subscriptions
     * @type {Set<string>}
     */
    this.subscriptions = new Set()
  }

  _onDial (peerInfo, conn, callback) {
    super._onDial(peerInfo, conn, (err) => {
      if (err) return callback(err)
      const idB58Str = peerInfo.id.toB58String()
      const peer = this.peers.get(idB58Str)
      // Immediately send my own subscriptions to the newly established conn
      peer.sendSubscriptions(this.subscriptions)
      setImmediate(() => callback())
    })
  }

  _processConnection (idB58Str, conn, peer) {
    pull(
      conn,
      lp.decode(),
      pull.map((data) => pb.rpc.RPC.decode(data)),
      pull.drain(
        (rpc) => {
          // console.log('JimZ', idB58Str.slice(-3), conn)
          return this._onRpc(idB58Str, rpc)
        },
        (err) => this._onConnectionEnd(idB58Str, peer, err)
      )
    )
  }

  _onRpc (idB58Str, rpc) {
    if (!rpc) {
      return
    }

    this.log('rpc from', idB58Str)
    const from = idB58Str.slice(-3)
    // console.log('Jim floodsub from', from)
    const subs = rpc.subscriptions
    const msgs = rpc.msgs

    if (msgs && msgs.length) {
      this._processRpcMessages(from, utils.normalizeInRpcMessages(rpc.msgs))
    }

    if (subs && subs.length) {
      const peer = this.peers.get(idB58Str)
      if (peer) {
        peer.updateSubscriptions(subs)
      }
    }
  }

  _processRpcMessages (from, msgs) {
    msgs.forEach((msg) => {
      const seqno = utils.msgId(msg.from, msg.seqno)
      // 1. check if I've seen the message, if yes, ignore
      if (this.cache.has(seqno)) {
        return
      }

      this.cache.put(seqno)
      console.log(`> ${from}:`, msg.from.slice(-3), msg.topicIDs.join(),
        msg.seqno.slice(-4).toString('hex'))

      // 2. emit to self
      // console.log('    - emit to self')
      let cancelled = false
      this._emitMessages(msg.topicIDs, [msg], () => { cancelled = true })

      // 3. propagate msg to others
      // console.log('    - forward')
      if (!cancelled) {
        this._forwardMessages(msg.topicIDs, [msg])
      } else {
        console.log('Jim cancelled')
      }
    })
  }

  _emitMessages (topics, messages, cancel) {
    topics.forEach((topic) => {
      if (!this.subscriptions.has(topic)) {
        return
      }

      messages.forEach((message) => {
        this.emit(topic, message, cancel)
      })
    })
  }

  _forwardMessages (topics, messages) {
    this.peers.forEach((peer) => {
      if (!peer.isWritable || !utils.anyMatch(peer.topics, topics)) {
        return
      }

      peer.sendMessages(utils.normalizeOutRpcMessages(messages))

      this.log('publish msgs on topics', topics, peer.info.id.toB58String())
    })
  }

  /**
   * Unmounts the floodsub protocol and shuts down every connection
   *
   * @param {Function} callback
   * @returns {undefined}
   *
   */
  stop (callback) {
    super.stop((err) => {
      if (err) return callback(err)
      this.subscriptions = new Set()
      callback()
    })
  }

  /**
   * Publish messages to the given topics.
   *
   * @param {Array<string>|string} topics
   * @param {Array<any>|any} messages
   * @returns {undefined}
   *
   */
  publish (topics, messages) {
    assert(this.started, 'FloodSub is not started')

    this.log('publish', topics, messages)

    topics = ensureArray(topics)
    messages = ensureArray(messages)

    const from = this.libp2p.peerInfo.id.toB58String()

    const buildMessage = (msg) => {
      const seqno = utils.randomSeqno()
      this.cache.put(utils.msgId(from, seqno))

      return {
        from: from,
        data: msg,
        seqno: seqno,
        topicIDs: topics
      }
    }

    const msgObjects = messages.map(buildMessage)

    // Emit to self if I'm interested
    let cancelled = false
    this._emitMessages(topics, msgObjects, () => { cancelled = true })

    // send to all the other peers
    if (!cancelled) {
      this._forwardMessages(topics, msgObjects)
    } else {
      console.log('Jim cancelled')
    }
  }

  /**
   * Subscribe to the given topic(s).
   *
   * @param {Array<string>|string} topics
   * @returns {undefined}
   */
  subscribe (topics) {
    assert(this.started, 'FloodSub is not started')

    topics = ensureArray(topics)

    topics.forEach((topic) => this.subscriptions.add(topic))

    this.peers.forEach((peer) => sendSubscriptionsOnceReady(peer))
    // make sure that FloodSub is already mounted
    function sendSubscriptionsOnceReady (peer) {
      if (peer && peer.isWritable) {
        return peer.sendSubscriptions(topics)
      }
      const onConnection = () => {
        peer.removeListener('connection', onConnection)
        sendSubscriptionsOnceReady(peer)
      }
      peer.on('connection', onConnection)
      peer.once('close', () => peer.removeListener('connection', onConnection))
    }
  }

  /**
   * Unsubscribe from the given topic(s).
   *
   * @param {Array<string>|string} topics
   * @returns {undefined}
   */
  unsubscribe (topics) {
    // Avoid race conditions, by quietly ignoring unsub when shutdown.
    if (!this.started) {
      return
    }

    topics = ensureArray(topics)

    topics.forEach((topic) => this.subscriptions.delete(topic))

    this.peers.forEach((peer) => checkIfReady(peer))
    // make sure that FloodSub is already mounted
    function checkIfReady (peer) {
      if (peer && peer.isWritable) {
        peer.sendUnsubscriptions(topics)
      } else {
        setImmediate(checkIfReady.bind(peer))
      }
    }
  }
}

module.exports = FloodSub
