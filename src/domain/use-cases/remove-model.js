'use strict'

import { isMainThread } from 'worker_threads'

/**
 * @typedef {Object} ModelParam
 * @property {String} modelName
 * @property {import('../model-factory').ModelFactory} models
 * @property {import('../datasource').default} repository
 * @property {import('../event-broker').EventBroker} broker
 * @property {...Function} handlers
 */

/**
 * @callback removeModel
 * @param {string} id
 * @returns {Promise<import("..").Model>}
 */

/**
 * @param {ModelParam} param0
 * @returns {removeModel}
 */
export default function removeModelFactory ({
  modelName,
  models,
  repository,
  threadpool,
  broker,
  handlers = []
} = {}) {
  const eventType = models.EventTypes.DELETE
  const eventName = models.getEventName(eventType, modelName)
  handlers.forEach(handler => broker.on(eventName, handler))

  return async function removeModel (id) {
    if (isMainThread) {
      const model = await repository.find(id)

      if (!model) {
        throw new Error('no such id')
      }

      const result = await threadpool.runJob(removeModel.name, id)
      if (result instanceof Error) throw result
      return result
    } else {
      try {
        const model = await models.loadModel()

        const deleted = models.deleteModel(model)
        const event = models.createEvent(eventType, modelName, deleted)

        const [brokerResult, repoResult] = await Promise.allSettled([
          broker.notify(eventName, event),
          repository.delete(id)
        ])

        if (brokerResult.status === 'rejected') {
          if (repoResult.status === 'fulfilled') {
            // event failed, put it back
            await repository.save(input.id, model)
          }
          throw new Error('model not deleted ' + brokerResult.reason)
        }

        return deleted
      } catch (error) {
        return new Error(error)
      }
    }
  }
}
