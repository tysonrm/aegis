'use strict'

import ModelFactory from '../model-factory'
import DataSourceFactory from '../datasource-factory'
import ThreadPoolFactory from '../thread-pool.js'
import EventBrokerFactory from '../event-broker'

import makeAddModel from './add-model'
import makeEditModel from './edit-model'
import makeListModels from './list-models'
import makeFindModel from './find-model'
import makeRemoveModel from './remove-model'
import makeLoadModels from './load-models'
import makeListConfig from './list-configs'
import makeEmitEvent from './emit-event'
import makeHotReload from './hot-reload'
import brokerEvents from './broker-events'

import { isMainThread } from 'worker_threads'

export function registerEvents () {
  // main thread handles event dispatch
  brokerEvents(
    EventBrokerFactory.getInstance(),
    DataSourceFactory,
    ModelFactory,
    ThreadPoolFactory
  )
}

/**
 *
 * @param {import('..').ModelSpecification} model
 */
function buildOptions (model) {
  const options = {
    modelName: model.modelName,
    models: ModelFactory,
    broker: EventBrokerFactory.getInstance(),
    handlers: model.eventHandlers
  }

  if (isMainThread) {
    return {
      ...options,
      // main thread does not write to persistent store
      repository: DataSourceFactory.getSharedDataSource(model.modelName),

      // only main thread knows about thread pools (no nesting)
      threadpool: ThreadPoolFactory.getThreadPool(model.modelName, {
        preload: false
      })
    }
  } else {
    return {
      ...options,
      // only worker threads can write to persistent storage
      repository: DataSourceFactory.getSharedDataSource(model.modelName)
    }
  }
}

/**
 * Generate use case functions for every model
 * @param {string} modelName
 * @param {function({}):function():Promise<Model>} factory
 * @returns
 */
function make (factory) {
  const specs = ModelFactory.getModelSpecs()
  return specs.map(spec => ({
    endpoint: spec.endpoint,
    fn: factory(buildOptions(spec))
  }))
}

/**
 * Generate use case functions for just one model
 * @param {string} modelName
 * @param {function({}):function():Promise<Model>} factory
 * @returns
 */
function makeOne (modelName, factory) {
  const spec = ModelFactory.getModelSpec(modelName.toUpperCase())
  return factory(buildOptions(spec))
}

const addModels = () => make(makeAddModel)
const editModels = () => make(makeEditModel)
const listModels = () => make(makeListModels)
const findModels = () => make(makeFindModel)
const removeModels = () => make(makeRemoveModel)
const loadModelSpecs = () => make(makeLoadModels)
const emitEvents = () => make(makeEmitEvent)
const hotReload = () => [
  {
    endpoint: 'reload',
    fn: makeHotReload({
      models: ModelFactory,
      broker: EventBrokerFactory.getInstance()
    })
  }
]
const listConfigs = () =>
  makeListConfig({
    models: ModelFactory,
    broker: EventBrokerFactory.getInstance(),
    dsFact: DataSourceFactory,
    threadpools: ThreadPoolFactory
  })

export const UseCases = {
  addModels,
  editModels,
  listModels,
  findModels,
  removeModels,
  loadModelSpecs,
  listConfigs,
  hotReload,
  registerEvents,
  emitEvents
}

export function UseCaseService (modelName = null) {
  if (typeof modelName === 'string') {
    const modelNameUpper = modelName.toUpperCase()
    return {
      addModel: makeOne(modelNameUpper, makeAddModel),
      editModel: makeOne(modelNameUpper, makeEditModel),
      listModels: makeOne(modelNameUpper, makeListModels),
      findModel: makeOne(modelNameUpper, makeFindModel),
      removeModel: makeOne(modelNameUpper, makeRemoveModel),
      loadModelSpecs: makeOne(modelNameUpper, makeLoadModels),
      emitEvents: makeOne(modelNameUpper, makeEmitEvent),
      listConfigs: listConfigs()
    }
  }
  return {
    addModels: addModels(),
    editModels: editModels(),
    listModels: listModels(),
    findModels: findModels(),
    removeModels: removeModels(),
    loadModelSpecs: loadModelSpecs(),
    hotReload: hotReload(),
    emitEvent: emitEvents(),
    listConfigs: listConfigs()
  }
}
