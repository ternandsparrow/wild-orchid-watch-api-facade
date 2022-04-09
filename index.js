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
  obsGetPath,
  obsUploadPath,
  taskCallbackUrl,
} = require('./src/routes.js')

const app = express()
const port = process.env.PORT || 3000

log.info(`WOW facade for iNat API
  Upstream API:   ${wowConfig.apiBaseUrl}
  Upstream iNat:  ${wowConfig.inatBaseUrl}
  Project slug:   ${wowConfig.inatProjectSlug}
  API Keys:       ${JSON.stringify(wowConfig.allApiKeys)}
  OAuth App ID:   ${wowConfig.oauthAppId}
  OAuth Secret:   ${wowConfig.oauthAppSecret}
  OAuth user:     ${wowConfig.oauthUsername}
  OAuth pass:     ${wowConfig.oauthPassword}
  Git SHA:        ${wowConfig.gitSha}
  Sentry DSN:     ${wowConfig.sentryDsn}
  Upload dir:     ${wowConfig.rootUploadDirPath}
  GCP region:     ${wowConfig.gcpRegion}
  GCP project:    ${wowConfig.gcpProject}
  GCP queue:      ${wowConfig.gcpQueue}
  Dev mode:       ${wowConfig.isDev}`)

app.get('/wow-observations', dataConsumerObservationsHandler)

app.options(obsGetPath, cors({methods: ['GET']}))
app.get(obsGetPath, cors({methods: ['GET']}), obsGetHandler)

app.options(obsUploadPath, cors({methods: ['POST']}))
app.post(obsUploadPath, cors({methods: ['POST']}), obsPostHandler)

app.post(`${taskCallbackUrl}/:uuid`, taskCallbackHandler)

app.get('/version', (req, res) => {
  log.info('Handling version endpoint')
  const result = {
    gitSha: wowConfig.gitSha,
    upstream: {
      inat: wowConfig.inatBaseUrl,
      inatApi: wowConfig.apiBaseUrl,
      inatProjectSlug: wowConfig.inatProjectSlug,
    },
  }
  return json(res, result, 200)
})

app.listen(port, () => {
  log.info(`WOW API Facade listening on ${port}`)
})
