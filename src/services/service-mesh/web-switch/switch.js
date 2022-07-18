'use strict'

import { IncomingMessage } from 'http'
import { nanoid } from 'nanoid'
import { hostname } from 'os'
import { Server, WebSocket } from 'ws'

const SERVICENAME = 'webswitch'
const CLIENT_MAX_ERRORS = 3
const CLIENT_MAX_RETRIES = 10
const MAX_CLIENTS = 10000

const startTime = Date.now()
const uptime = () => Math.round(Math.abs((Date.now() - startTime) / 1000 / 60))
const configRoot = require('../../../config').hostConfig
const config = configRoot.services.serviceMesh.WebSwitch
const debug = /true/i.test(config.debug)
const isSwitch = /true/i.test(process.env.IS_SWITCH) || config.isSwitch
const headers = {
  host: 'x-webswitch-host',
  role: 'x-webswitch-role',
  pid: 'x-webswitch-pid'
}
let messagesSent = 0
let backupSwitch

/**
 * Attach {@link ServiceMeshAdapter} to the API listener socket.
 * Listen for upgrade events from http server and switch
 * client to WebSockets protocol. Clients connecting this
 * way are using the service mesh, not the REST API. Use
 * key + cert in {@link secureCtx} for secure connection.
 * @param {https.Server|http.Server} httpServer
 * @param {tls.SecureContext} [secureCtx] if ssl enabled
 * @returns {import('ws').server}
 */
export function attachServer (httpServer, secureCtx = {}) {
  const info = Symbol('webswitch')
  /**
   * list of client connections (federation hosts, browsers, etc)
   * @type {Map<string,WebSocket>}
   */
  const clients = new Map()

  /**
   * WebSocket {@link server} that may serve as the webswitch.
   */
  const server = new Server({
    ...secureCtx,
    clientTracking: false,
    server: httpServer
  })

  /**
   * Look for `evidence` of {@link rules} violation and return result
   * @param {IncomingMessage} request
   * @returns {boolean} if true, one or more rules has been broken
   */
  function breaksRules (request) {
    console.debug(request.headers)

    const rules = {
      protocol: {
        op: 'or',
        hasWebSwitchHeader: () =>
          request.headers['sec-websocket-protocol'] === 'webswitch',
        hasProtocolHeaders: () =>
          headerList.filter(header => request.headers[header]).length ===
          headerList.length
      },
      rateLimits: {
        op: 'and',
        dataTransferedOK: () => true,
        connectionRateOK: () => true
      },
      capacity: {
        op: 'and',
        maxConnectionsOK: () => clients.size + 1 < MAX_CLIENTS
      }
    }

    const breaks = {
      and: rules => rules.reduce((truth, rule) => rule() && truth),
      or: rules => rules.reduce((truth, rule) => rule() || truth)
    }

    const extract = rule =>
      Object.values(rules[rule]).filter(r => typeof r === 'function')

    const broken = rule => breaks[rules[rule].op](extract(rule))
    return Object.keys(rules).filter(broken)
  }

  function foundHeaders (request) {
    const list = Object.values(headers)
    const node = list.filter(h => request.headers[h]).length === list.length
    const browser = request.headers['sec-websocket-protocol'] === 'webswitch'
    return node || browser
  }

  function withinRateLimits (request) {
    const client = findClient(request)
    if (client) return true
  }

  server.shouldHandle = request => {
    // const broken = breaksRules(request)
    // console.info(`protocol violations: ${broken}`)
    // return !(broken.length > 0)
    return foundHeaders(request) && withinRateLimits(request)
  }

  server.on('upgrade', (request, socket, head) => {
    server.handleUpgrade(request, socket, head, ws => {
      server.emit('connection', ws, request)
    })
  })

  function setClientInfo (ws, request) {
    ws[info] = {}
    ws[info].id = nanoid()
    ws[info].pid = request.headers[headers.pid] || Math.floor(Math.random())
    ws[info].host = request.headers[headers.host] || request.headers.host
    ws[info].role = request.headers[headers.role] || 'brownser'
    ws[info].errors = 0
    ws[info].uniqueName = ws[info].host + ws[info].pid
  }

  function trackClient (client, request) {
    console.debug(trackClient.name)
    setClientInfo(client, request)

    if (clients.has(client[info].uniqueName)) {
      console.warn('found duplicate name', client[info].uniqueName)
      const oldClient = clients.get(client[info].uniqueName)
      if (oldClient) oldClient.close(4000, 'term')
      process.nextTick(() => oldClient.terminate())
    }

    client[info].initialized = true
    console.info('client initialized', client[info])
    clients.set(client[info].uniqueName, client)
  }

  server.on('connection', function (client, request) {
    trackClient(client, request)

    client.on('error', function (error) {
      client[info].errors++

      console.error({
        fn: 'client.on(error)',
        client: client[info],
        error
      })

      if (client[info].errors > CLIENT_MAX_ERRORS) {
        console.warn('terminating client: too many errors')
        clients.delete(client[info].uniqueName)
        client.close(4888, 'too many errors')
      }
    })

    client.on('ping', () => client.pong())

    client.on('message', function (message) {
      try {
        console.debug(clients)
        const msg = JSON.parse(message.toString())

        if (client[info].initialized) {
          if (msg === 'status') {
            sendStatus(client)
            return
          }
          broadcast(message, client)
          return
        }

        assignBackup(client)
        // tell client if its now a backup switch or not
        sendClient(client, JSON.stringify(client[info]))
        // look for telemetry data in msg
        updateTelemetry(client, msg)
        // tell everyone about new node (ignore browsers)
        if (client[info] && client[info].role === 'node')
          broadcast(statusReport(), client)
        return
      } catch (e) {
        console.error(client.on.name, 'on message', e)
      }

      // bad protocol
      client.close(4403, 'bad request')
      console.warn('terminated client', client[info])
    })

    client.on('close', function (code, reason) {
      console.info({
        msg: 'client closing',
        code,
        reason: reason.toString(),
        client: client[info]
      })

      clients.delete(client[info]?.uniqueName)
      client.close(4988, 'ack')
      process.nextTick(() => client.terminate())

      reassignBackup(client)
      broadcast(statusReport(), client)
    })
  })

  function broadcast (data, sender) {
    clients.forEach(function (client) {
      if (client[info]?.uniqueName !== sender[info]?.uniqueName) {
        console.assert(!debug, 'sending client', client[info], data.toString())
        sendClient(client, data)
        messagesSent++
      }
    })

    if (server.uplink && server.uplink !== sender) {
      server.uplink.publish(data)
      messagesSent++
    }
  }

  function sendClient (client, message, retries = []) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
      return
    }
    if (retries.length < CLIENT_MAX_RETRIES)
      setTimeout(sendClient, 1000, client, message, retries.push(1))
  }

  function trackClient (client, request) {
    setClientInfo(client, request)

    if (clients.has(client[info].uniqueName)) {
      console.warn('found duplicate name', client[info].uniqueName)
      const oldClient = clients.get(client[info].uniqueName)
      if (oldClient) oldClient.close(4000, 'term')
      process.nextTick(() => oldClient.terminate())
    }
    client[info].initialized = true
    clients.set(client[info].uniqueName, client)
    console.info('client initialized', client[info])
  }

  function assignBackup (client) {
    if (
      isSwitch &&
      // is there a backup already?
      !backupSwitch &&
      // can't be a browser
      client[info] &&
      client[info].role === 'node' &&
      client[info].hostname !== hostname()
    ) {
      backupSwitch = client[info]?.id
      console.info('new backup switch: ', client[info])
    }
  }

  function reassignBackup (client) {
    if (client[info]?.id === backupSwitch) {
      for (let c of clients) {
        if (
          c[info]?.role === 'node' &&
          c[info].hostname !== hostname() &&
          c[info].id !== backupSwitch
        ) {
          backupSwitch = c[info].id
          c[info].isBackupSwitch = true
          return
        }
      }
    }
  }

  function statusReport () {
    return JSON.stringify({
      eventName: 'meshStatusReport',
      servicePlugin: SERVICENAME,
      uptimeMinutes: uptime(),
      messagesSent,
      clientsConnected: clients.size,
      uplink: server.uplink ? server.uplink.info : 'no uplink',
      isPrimarySwitch: isSwitch,
      clients: [...clients.values()].map(v => ({
        ...v[info],
        state: v.readyState
      }))
    })
  }

  /**
   *
   * @param {WebSocket} client
   */

  function sendStatus (client) {
    sendClient(client, statusReport())
  }

  function updateTelemetry (client, msg) {
    if (!client[info]) return
    if (msg?.telemetry && client[info]) client[info].telemetry = msg.telemetry
    if (msg?.services && client[info]) client[info].services = msg.services
    client[info].isBackupSwitch = backupSwitch === client[info].id
  }

  // try {
  //   // configure uplink
  //   if (config.uplink) {
  //     const node = require('./node')
  //     server.uplink = node
  //     node.setUplinkUrl(config.uplink)
  //     node.onUplinkMessage(msg => broadcast(msg, node))
  //     node.connect()
  //   }
  // } catch (e) {
  //   console.error('uplink', e)
  // }

  return server
}
