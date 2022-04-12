const fs = require('fs')
require('dotenv').config()
const {CloudTasksClient} = require('@google-cloud/tasks')
const {log, wowConfig} = require('../src/lib.js')

async function main(url) {
  if (!url) {
    throw new Error('First param must be callback URL')
  }
  setupGcpAuth()
  log.info(`Using url=${url}`)
  const client = new CloudTasksClient()
  log.info('Configuring queue client')
  const parent = client.queuePath(
    wowConfig().gcpProject,
    wowConfig().gcpRegion,
    wowConfig().gcpQueue
  )
  const task = {
    httpRequest: {
      httpMethod: 'GET',
      url,
    },
  }
  const request = {parent: parent, task: task}
  log.info('Submitting task')
  await client.createTask(request)
  log.info('Done')
}

function setupGcpAuth() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    log.info('GOOGLE_APPLICATION_CREDENTIALS is set, using it')
    return
  }
  const keyPath = 'key.json'
  try {
    fs.accessSync(keyPath)
    log.info('Key file exists')
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath
    return
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
    if (process.env.GCP_KEY_JSON_BASE64) {
      log.info('Key file does not exist, but we have the base64 blob')
      log.info('Create the key file with this command:')
      log.info(`  bash -c 'source .env; echo $GCP_KEY_JSON_BASE64 | base64 -d > ${keyPath}'`)
      throw new Error('Key file does not exist. Use command above!!!')
    }
    throw new Error('Key file does not exist!')
  }
}

main(process.argv[2]).catch(err => {
  log.error('Failed to run', err)
  process.exit(1)
})
