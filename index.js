const cors = require('cors')
const express = require('express')
const {json, log, wowConfig} = require('./src/lib.js')
const {dataConsumerObservationsHandler} = require('./src/data-consumers.js')
const {
  obsGetHandler,
  obsPostHandler,
  taskCallbackHandler,
} = require('./src/data-producers.js')
const {
  obsUploadPath,
  taskCallbackUrl,
} = require('./src/routes.js')

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

app.options(obsUploadPath, cors({methods: ['POST']}))
app.post(obsUploadPath, cors({methods: ['POST']}), obsPostHandler)

app.post(`${taskCallbackUrl}/:uuid/:seq`, taskCallbackHandler)

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
