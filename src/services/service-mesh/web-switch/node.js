/**
 * webswitch (c)
 *
 * Websocket clients connect to a common ws server,
 * called a webswitch. When a client sends a message,
 * webswitch broadcasts the message to all other
 * connected clients, as well as any uplink webswitch
 * servers it can connect to. A Webswitch server can also
 * receive messgages from uplinks and will broadcast
 * those to its clients.
 */

'use strict'

/** @module services/mesh/Node */

import os from 'os'
import WebSocket from 'ws'
import Dns from 'multicast-dns'
import EventEmitter from 'events'
import { CircuitBreaker } from '../../index'

const HOSTNAME = 'webswitch.local'
const SERVICENAME = 'webswitch'
const TIMEOUTEVENT = 'webswitchTimeout'

const configRoot = require('../../../config').hostConfig
const config = configRoot.services.serviceMesh.WebSwitch
const retryInterval = config.retryInterval || 2000
const maxRetries = config.maxRetries || 5
const debug = config.debug || /true/i.test(process.env.DEBUG)
const heartbeat = config.heartbeat || 10000
const sslEnabled = /true/i.test(process.env.SSL_ENABLED)
const normalPort = process.env.PORT || 80
const sslPort = process.env.SSL_PORT || 443
const activePort = sslEnabled ? sslPort : normalPort
const activeProto = sslEnabled ? 'wss' : 'ws'
const activeHost =
  process.env.DOMAIN ||
  configRoot.services.cert.domain ||
  configRoot.general.fqdn
const proto = config.isSwitch ? activeProto : config.protocol
const port = config.isSwitch ? activePort : config.port
const host = config.isSwitch ? activeHost : config.host
const eventEmitter = new EventEmitter()

const _url = (proto, host, port) =>
  proto && host && port ? `${proto}://${host}:${port}` : null

let serviceUrl = _url(proto, host, port)
let isBackupSwitch = config.isBackupSwitch || false
let activateBackup = false
let uplinkCallback

let dnsPriority
/** @type {function():string[]} */
let availableMicroservices = () => []
/** @type {WebSocket} */
let ws

const DnsPriority = {
  setHigh () {
    dnsPriority = { priorities: 10, weight: 20 }
  },
  setMedium () {
    dnsPriority = { priorities: 20, weight: 40 }
  },
  setLow () {
    dnsPriority = { priorities: 40, weight: 80 }
  },
  getCurrent () {
    return dnsPriority
  },
  match (prio) {
    const { priority, weight } = this.getCurrent()
    return prio.priority === priority && prio.weight === weight
  },
  setBackupPriority () {
    // set to low
    config.priority = 40
    config.weight = 80
  }
}

DnsPriority.setHigh()

function checkTakeover () {
  if (DnsPriority.getCurrent().priority === config.priority)
    activateBackup = true
}

/**
 * Use multicast DNS to find the host
 * instance configured as the "switch"
 * node for the local area network.
 *
 * @returns {Promise<string>} url
 */
async function resolveServiceUrl () {
  const dns = Dns()
  let url

  return new Promise(function (resolve) {
    dns.on('response', function (response) {
      debug && console.debug({ fn: resolveServiceUrl.name, response })

      const answer = response.answers.find(
        a =>
          a.name === SERVICENAME &&
          a.type === 'SRV' &&
          DnsPriority.match(a.data)
      )

      if (answer) {
        url = _url(proto, answer.data.target, answer.data.port)
        console.info({ msg: 'found dns service record for', SERVICENAME, url })
        resolve(url)
      }
    })

    /**
     * Query DNS for the webswitch service.
     * Recursively retry by incrementing a
     * counter we pass to ourselves on the
     * stack.
     *
     * @param {number} retries number of query attempts
     * @returns
     */
    function runQuery (retries = 0) {
      if (retries > maxRetries / 2) {
        DnsPriority.setMedium()
        checkTakeover()
      } else if (retries > maxRetries) {
        DnsPriority.setLow()
        checkTakeover()
      }

      // query the service name
      dns.query({
        questions: [
          {
            name: SERVICENAME,
            type: 'SRV',
            data: DnsPriority.getCurrent()
          }
        ]
      })

      if (url) {
        resolve(url)
        return
      }

      setTimeout(() => runQuery(++retries), retryInterval)
    }

    runQuery()

    dns.on('query', function (query) {
      debug && console.debug('got a query packet:', query)

      const questions = query.questions.filter(
        q => q.name === SERVICENAME || q.name === HOSTNAME
      )

      if (!questions[0]) {
        console.assert(!debug, {
          fn: 'dns query',
          msg: 'no questions',
          questions
        })
        return
      }

      if (config.isSwitch || (isBackupSwitch && activateBackup)) {
        const answer = {
          answers: [
            {
              name: SERVICENAME,
              type: 'SRV',
              data: {
                port: activePort,
                weight: config.priority,
                priority: config.weight,
                target: activeHost
              }
            }
          ]
        }

        console.info({
          fn: dns.on.name + "('query')",
          isSwitch: config.isSwitch,
          isBackupSwitch,
          activateBackup,
          msg: 'answering query packet',
          questions,
          answer
        })

        dns.respond(answer)
      }
    })
  })
}

/**
 * Set callback for uplink.
 * @param {function():Promise<void>} callback
 */
export function onUplinkMessage (callback) {
  uplinkCallback = callback
}

/**
 * server sets uplink host
 */
export function setUplinkUrl (uplinkUrl) {
  serviceUrl = uplinkUrl
  ws = null // trigger reconnect
}

/**
 * @typedef {object} HandshakeMsg
 * @property {string} proto the protocol 'web-switch'
 * @property {'node'|'browser'|'uplink'} role of the client
 * @property {number} pid - processid of the client or 1 for browsers
 * @property {string} serviceUrl - web-switch url for the client
 * @property {string[]} services - names of services running on the instance
 * @property {string} address - address of the client
 * @property {string} url - url to connect to client instance directly
 */

function format (event) {
  if (event instanceof ArrayBuffer) {
    // binary frame
    const view = new DataView(event)
    debug && console.debug('arraybuffer', view.getInt32(0))
    return event
  }
  if (typeof event === 'object') return JSON.stringify(event)
  return event
}

/**
 *
 * @param {object} event
 * @returns
 */
function send (event) {
  if (ws?.readyState) {
    const breaker = new CircuitBreaker(__filename + send.name, ws.send)
    breaker.errorListener(eventEmitter)
    breaker.invoke(format(event))
    return
  }
  setTimeout(send, 1000, event)
}

/**
 *
 */
function startHeartbeat () {
  let receivedPong = true

  ws.addListener('pong', function () {
    console.assert(!debug, 'received pong')
    receivedPong = true
  })

  const intervalId = setInterval(async function () {
    if (receivedPong) {
      receivedPong = false
      // expect a pong back
      ws.ping(0x9)
    } else {
      try {
        clearInterval(intervalId)

        eventEmitter.emit(TIMEOUTEVENT)

        console.error({
          fn: startHeartbeat.name,
          receivedPong,
          msg: 'no response, trying new conn'
        })

        // keep trying
        reconnect()
      } catch (error) {
        console.error(startHeartbeat.name, error)
      }
    }
  }, heartbeat)
}

/**
 *
 */
const protocol = {
  eventName: 'handshake',
  metaEvent: true,
  proto: SERVICENAME,
  role: 'node',
  pid: process.pid,
  hostname: os.hostname(),
  isBackupSwitch,
  activateBackup,

  serialize () {
    return JSON.stringify({
      ...this,
      services: availableMicroservices(),
      mem: process.memoryUsage(),
      cpu: process.cpuUsage()
    })
  },

  validate (message) {
    if (message) {
      let msg
      const valid = message.eventName || message.proto === this.proto

      if (typeof message === 'object') {
        msg = message = JSON.stringify(message)
      }

      const dynamicBackup = this.becomeBackupSwitch(message)
      if (dynamicBackup) DnsPriority.setBackupPriority()
      isBackupSwitch = true

      console.assert(valid, `invalid message ${msg}`)
      return valid
    }
    return false
  },

  becomeBackupSwitch (message) {
    return message.isBackupSwitch === true
  }
}

/**
 * @param {string} eventName
 * @param {(...args)=>void} callback
 */
export async function subscribe (eventName, callback) {
  try {
    eventEmitter.on(eventName, callback)
  } catch (error) {
    console.error({ fn: 'subscribe', error })
  }
}

/**
 *
 */
async function _connect () {
  if (!ws) {
    // null unless this is a switch or set manually by config file
    if (!serviceUrl) serviceUrl = await resolveServiceUrl()
    console.info({ fn: _connect.name, serviceUrl })

    ws = new WebSocket(serviceUrl)

    ws.on('open', function () {
      send(protocol.serialize())
      startHeartbeat()
    })

    ws.on('error', function (error) {
      console.error({ fn: _connect.name, error })
      reconnect()
    })

    ws.on('message', async function (message) {
      try {
        const event = JSON.parse(message.toString())
        debug && console.debug('received event:', event)

        if (protocol.validate(event)) {
          // fire events
          if (event?.eventName !== '*') {
            // notify subscribers to this event
            eventEmitter.emit(event.eventName)

            // notify subscribers to all events
            eventEmitter.listeners('*').forEach(listener => listener(event))
          }
          // send to uplink if there is one
          if (uplinkCallback) await uplinkCallback(message)
          return
        }
        console.warn('unknown message type', message.toString())
      } catch (error) {
        console.error({ fn: ws.on.name + '("message")', error })
      }
    })
  }
}

/**
 *
 * @param {{services:()=>*}} [serviceInfo]
 */
export async function connect (serviceInfo = {}) {
  availableMicroservices = serviceInfo?.services
  await _connect()
}

let reconnecting = false

/**
 *
 */
async function reconnect (attempts = 0) {
  if (reconnecting) return
  reconnecting = true
  ws = null
  setTimeout(() => {
    if (++attempts % 10 === 0) {
      // try new url after a minute
      serviceUrl = null
    }
    try {
      _connect()
    } catch (error) {
      console.error({ fn: reconnect.name, error })
    }
    reconnecting = false
    if (!ws) reconnect(attempts)
    else console.info('reconnected to switch')
  }, 6000)
}

/**
 * Call this method to broadcast a message on the web-switch network
 * @param {object} event
 * @returns
 */
export async function publish (event) {
  try {
    if (!event) {
      console.error(publish.name, 'no event provided')
      return
    }
    await _connect()
    send(event)
  } catch (e) {
    console.error('publish', e)
  }
}
