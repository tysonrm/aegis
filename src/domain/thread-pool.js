'use strict'

import { Worker, MessageChannel } from 'worker_threads'
import { EventBrokerSingleton } from './event-broker'

const broker = EventBrokerSingleton.getInstance()
const DEFAULT_THREADPOOL_SIZE = 2

/**
 * @typedef {object} Thread
 * @property {string} name
 * @property {number} threadId
 * @property {Worker} worker
 * @property {{[x:string]:*}} metadata
 */

function setSubChannel (channel, worker) {
  const { port1, port2 } = new MessageChannel()
  worker.postMessage({ port: port1, channel }, [port1])
  broker.channels[channel].push(port2)
}

function setSubChannels (worker) {
  setSubChannel('workflow', worker)
  setSubChannel('cache', worker)
}

/**
 * @returns {Thread}
 */
function newThread (file, workerData, metadata) {
  console.debug('creating new thread', newThread.name)
  const worker = new Worker(file, { workerData })
  // setSubChannels(worker)
  return {
    worker,
    threadId: worker.threadId,
    metadata,
    createdAt: Date.now(),
    toJSON () {
      return {
        ...this,
        createdAt: new Date(this.createdAt).toUTCString()
      }
    }
  }
}

/**
 *
 * @param {{[x:string]:string|number}} metaCriteria
 * @param {Thread} thread
 *
 */
function metadataMatch (metaCriteria, thread) {
  return Object.keys(metaCriteria).every(k =>
    thread.metadata[k] ? metaCriteria[k] === thread.metadata[k] : true
  )
}

function handleRequest (thread) {}

export class ThreadPool {
  constructor ({
    file,
    name = null,
    workerData = {},
    numThreads = DEFAULT_THREADPOOL_SIZE,
    metadata = null
  } = {}) {
    this.name = name
    this.availThreads = []
    this.waitingTasks = []
    for (let i = 0; i < numThreads; i++) {
      this.availThreads.push(newThread(file, workerData, metadata))
    }
    console.debug('threads in pool', this.availThreads.length, numThreads)
  }

  /**
   *
   * @param {string} file
   * @param {*} workerData
   * @param {*} metadata
   * @returns {Thread}
   */
  addThread (file, workerData, metadata = null) {
    const thread = newThread(file, workerData, metadata)
    this.availThreads.push(thread)
    return thread
  }

  removeThread (name = null, threadId = null, metaCriteria = null) {
    if (this.availThreads.length > 0) {
      if (name || threadId || metaCriteria) {
        const threadsToRemove = this.availThreads.filter(
          t =>
            t.name === name ||
            t.threadId === threadId ||
            metadataMatch(metaCriteria, t)
        )
        if (threadsToRemove.length > 0) {
          console.info('terminating threads:', threadsToRemove)
          threadsToRemove.forEach(t => t.worker.terminate())
          return true
        }
        return false
      }
      const thread = this.availThreads.pop()
      console.info('terminating thread:', thread)
      thread.worker.terminate()
      return true
    }
    console.warn('no threads available')
    return false
  }

  availableThreads () {
    return this.availThreads.length
  }

  taskQueueDepth () {
    return this.waitingTasks.length
  }

  handleRequest (taskName, taskData, thread) {
    return new Promise((resolve, reject) => {
      thread.worker.once('message', result => {
        if (this.waitingTasks.length > 0) {
          this.waitingTasks.shift()(thread)
        } else {
          this.availThreads.push(thread)
        }
        resolve(result)
      })
      thread.worker.on('error', reject)
      thread.worker.postMessage({ name: taskName, data: taskData })
    })
  }
  dd
  runTask (taskName, taskData) {
    return new Promise(async (resolve, reject) => {
      if (this.availThreads.length > 0) {
        const result = await this.handleRequest(
          taskName,
          taskData,
          this.availThreads.shift()
        )
        resolve(result)
      } else {
        this.waitingTasks.push(thread =>
          handleRequest(taskName, taskData, thread)
        )
      }
    })
  }
}

const ThreadPoolFactory = (() => {
  const threadPools = new Map()

  function createThreadPool (modelName) {
    console.debug(createThreadPool.name)
    const pool = new ThreadPool({
      file: './dist/worker.js',
      modelName,
      workerData: { modelName },
      numThreads: DEFAULT_THREADPOOL_SIZE
    })
    threadPools.set(modelName, pool)
    return pool
  }

  function getThreadPool (modelName) {
    if (threadPools.has(modelName)) return threadPools.get(modelName)
    return createThreadPool(modelName)
  }

  return {
    getThreadPool
  }
})()

export default ThreadPoolFactory
