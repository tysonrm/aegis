'use strict'

const ServerInterface = require('./server-interface')

import * as plugins from './plugins'

const config = require('../../config').hostConfig
const selectedPlugin = config.services.activeServiceMesh
/**
 * Which mesh service implementations are enabled?
 */
const enabledPlugins = Object.entries(config.services.serviceMesh)
  .filter(([, v]) => v.enabled)
  .map(([k]) => k) || ['WebSwitch']

/**
 * Which mesh service do we use?
 */
const configuredPlugin = enabledPlugins.includes(selectedPlugin)
  ? selectedPlugin
  : 'WebSwitch'

/**
 * Bind the adapter.
 * @type {ServiceMeshAdapter}
 */
export const ServiceMeshPlugin = {
  ...Object.keys(ServerInterface)
    .map(port => ({
      [port]: ServerInterface[port](plugins[configuredPlugin])
    }))
    .reduce((a, b) => ({ ...a, ...b }))
}
