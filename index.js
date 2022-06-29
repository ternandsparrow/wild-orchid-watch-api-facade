const cors = require('cors')
const express = require('express')
const {
  json,
  log,
  taskCallbackUrlPrefix,
  taskStatusUrlPrefix,
  wowConfig,
} = require('./src/lib.js')
const {dataConsumerObservationsHandler} = require('./src/data-consumers.js')
const {
  authMiddleware: userAuthMiddleware,
  getUuidsWithPendingStatus,
  initDb,
  obsDeleteHandler,
  obsUpsertHandler,
  obsTaskStatusHandler,
  taskCallbackDeleteHandler,
  taskCallbackMiddleware,
  taskCallbackPostHandler,
} = require('./src/data-producers.js')

const uuidPathMatcher = ':uuid([0-9a-fA-F-]+)'
const obsUploadUrl = `/observations/${uuidPathMatcher}`
const obsDeleteUrl = `/observations/:inatId([0-9]+)/${uuidPathMatcher}`
const statusUrl = `${taskStatusUrlPrefix}/${uuidPathMatcher}`
const app = express()
const port = process.env.PORT || 3000

if (wowConfig().isLocalDev) {
  log.debug(`WOW facade for iNat API
  Upstream API:   ${wowConfig().apiBaseUrl}
  Upstream iNat:  ${wowConfig().inatBaseUrl}
  Project slug:   ${wowConfig().inatProjectSlug}
  API Keys:       ${JSON.stringify(wowConfig().allApiKeys)}
  OAuth App ID:   ${wowConfig().oauthAppId}
  OAuth Secret:   ${wowConfig().oauthAppSecret}
  OAuth user:     ${wowConfig().oauthUsername}
  OAuth pass:     ${wowConfig().oauthPassword}
  Git SHA:        ${wowConfig().gitSha}
  Sentry DSN:     ${wowConfig().sentryDsn}
  Upload dir:     ${wowConfig().rootUploadDirPath}
  GCP region:     ${wowConfig().gcpRegion}
  GCP project:    ${wowConfig().gcpProject}
  GCP queue:      ${wowConfig().gcpQueue}
  Env name:       ${wowConfig().deployedEnvName}`)
}
log.info(`Started; running version ${wowConfig().gitSha}`)

app.get('/wow-observations', dataConsumerObservationsHandler)

const corsMiddleware = cors({methods: ['GET', 'POST', 'DELETE']})
app.options(obsUploadUrl, corsMiddleware)
app.options(statusUrl, corsMiddleware)

// only one endpoint for create and update. The facade figures out what type of
// req to send to iNat. Keeps the client simple.
app.post(obsUploadUrl, corsMiddleware, userAuthMiddleware, obsUpsertHandler)
app.delete(obsDeleteUrl, corsMiddleware, userAuthMiddleware, obsDeleteHandler)

// poll progress of create, update or delete task
app.get(statusUrl, corsMiddleware, userAuthMiddleware, obsTaskStatusHandler)

// endpoints for task queue to call
app.post(`${taskCallbackUrlPrefix}/${uuidPathMatcher}`, taskCallbackMiddleware,
  taskCallbackPostHandler)
app.delete(`${taskCallbackUrlPrefix}/${uuidPathMatcher}`, taskCallbackMiddleware,
  taskCallbackDeleteHandler)

app.get('/ops/task-statuses', getUuidsWithPendingStatus)

app.get('/version', (req, res) => {
  log.info('Handling version endpoint')
  const result = {
    gitSha: wowConfig().gitSha,
    envName: wowConfig().deployedEnvName,
    upstream: {
      inat: wowConfig().inatBaseUrl,
      inatApi: wowConfig().apiBaseUrl,
      inatProjectSlug: wowConfig().inatProjectSlug,
    },
  }
  return json(res, result, 200)
})

initDb()
app.listen(port, () => {
  log.info(`WOW API Facade listening on port ${port}`)
})
