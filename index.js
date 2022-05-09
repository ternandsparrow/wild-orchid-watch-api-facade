const cors = require('cors')
const express = require('express')
const {json, log, taskCallbackUrlPrefix, wowConfig} = require('./src/lib.js')
const {dataConsumerObservationsHandler} = require('./src/data-consumers.js')
const {
  obsDeleteStatusHandler,
  obsPostHandler,
  obsPutHandler,
  obsTaskStatusHandler,
  taskCallbackPostHandler,
  taskCallbackPutHandler,
  authMiddleware: userAuthMiddleware,
} = require('./src/data-producers.js')

const uuidPathMatcher = ':uuid([0-9a-fA-F-]+)'
const seqPathMatcher = ':seq([0-9]+)'
const obsUploadUrl = `/observations/${uuidPathMatcher}`
const deleteStatusUrl = `/task-status/:inatId([0-9]+)/delete`
const otherStatusUrl = `/task-status/${uuidPathMatcher}/${seqPathMatcher}`
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

const corsMiddleware = cors({methods: ['POST', 'PUT']})
app.options(obsUploadUrl, corsMiddleware)
app.options(deleteStatusUrl, corsMiddleware)
app.options(otherStatusUrl, corsMiddleware)

// create an observation
app.post(obsUploadUrl, corsMiddleware, userAuthMiddleware, obsPostHandler)
// update an observation
app.put(obsUploadUrl, corsMiddleware, userAuthMiddleware, obsPutHandler)

// poll upstream to see if delete has happened
app.get(deleteStatusUrl, corsMiddleware, obsDeleteStatusHandler)
// poll progress of create or update task
app.get(otherStatusUrl, corsMiddleware, userAuthMiddleware, obsTaskStatusHandler)

// endpoint for task queue to call, for "create obs" tasks
app.post(`${taskCallbackUrlPrefix}/${uuidPathMatcher}/${seqPathMatcher}`, taskCallbackPostHandler)
// endpoint for task queue to call, for "update obs" tasks
app.put(`${taskCallbackUrlPrefix}/${uuidPathMatcher}/${seqPathMatcher}`, taskCallbackPutHandler)

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

app.listen(port, () => {
  log.info(`WOW API Facade listening on port ${port}`)
})
