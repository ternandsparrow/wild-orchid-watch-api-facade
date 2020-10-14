const express = require('express')
const axios = require('axios')
const wowLib = require('./src/lib.js')
const Sentry = require('@sentry/node')
const Tracing = require('@sentry/tracing')

const app = express()
const port = process.env.PORT || 3000

const apiBaseUrl = wowLib.stripTrailingSlashes(
  getRequiredEnvVar('INAT_API_PREFIX'),
)
const inatBaseUrl = wowLib.stripTrailingSlashes(
  getRequiredEnvVar('INAT_PREFIX'),
)

const gitSha = process.env.GIT_SHA || '(local dev)'

// the WOW project. Slug is the fragment of URL, e.g. wow_project, not the
// numeric ID.
const inatProjectSlug = getRequiredEnvVar('INAT_PROJECT_SLUG')

const oauthAppId = getRequiredEnvVar('OAUTH_APP_ID')
const oauthAppSecret = getRequiredEnvVar('OAUTH_APP_SECRET')
// these login details must be for a user that is a curator/manager of the iNat
// project as this role allows us to get unobscured GPS coordinates for
// observations. It's probably smart to create a dedicated user just for this.
const oauthUsername = getRequiredEnvVar('OAUTH_USERNAME')
const oauthPassword = getRequiredEnvVar('OAUTH_PASSWORD')

// these are keys we issue for clients to call us. We support multiple keys so
// each caller has their own one. This makes rotating keys easier and we can
// compute some metrics on who is calling. The keys can be any string, they're
// just opaque tokens. We have a check to make sure they're sufficiently long
// that brute forcing isn't realistic.
const allApiKeys = [
  getRequiredEnvVar('CLIENT1_API_KEY'),
  getRequiredEnvVar('CLIENT2_API_KEY'),
  getRequiredEnvVar('CLIENT3_API_KEY'),
  getRequiredEnvVar('CLIENT4_API_KEY'),
].reduce((accum, curr) => {
  if (!curr) {
    return accum
  }
  const minKeyLength = 36
  if (curr.length < minKeyLength) {
    throw new Error(
      `Config error: API key is shorter than min length (${minKeyLength}): '${curr}'`,
    )
  }
  accum.push(curr)
  return accum
}, [])

const sentryDsn = process.env.SENTRY_DSN
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    tracesSampleRate: 1.0,
  })
} else {
  console.warn('[WARN] No Sentry DSN provided, refusing to init Sentry client')
}

let outboundAuth = null

const isDev = process.env.IS_DEV_MODE === 'true'

console.info(`WOW facade for iNat API
  Upstream API:   ${apiBaseUrl}
  Upstream iNat:  ${inatBaseUrl}
  Project slug:   ${inatProjectSlug}
  API Keys:       ${JSON.stringify(allApiKeys)}
  OAuth App ID:   ${oauthAppId}
  OAuth Secret:   ${oauthAppSecret}
  OAuth user:     ${oauthUsername}
  OAuth pass:     ${oauthPassword}
  Git SHA:        ${gitSha}
  Sentry DSN:     ${sentryDsn}
  Dev mode:       ${isDev}`)

app.get('/wow-observations', async (req, res) => {
  const transaction = Sentry.startTransaction({
    op: '/wow-observations',
    name: 'The obs handler function',
  })
  try {
    const startMs = Date.now()
    const apiKey = req.headers.authorization
    const isAuthorised = allApiKeys.includes(apiKey)
    if (!isAuthorised) {
      infoLog('Rejecting unauthorised request with API key:', apiKey)
      const forbidden = 403
      return json(
        res,
        {
          msg: 'API key (passed via Authorization header) missing or not valid',
          suppliedApiKey: apiKey || null,
          status: forbidden,
        },
        forbidden,
      )
    }
    infoLog('Handling request from API key:', apiKey)
    const authHeader = await getOutboundAuthHeader()
    const result = await doGetToInat(authHeader, req.query)
    const elapsed = Date.now() - startMs
    infoLog(`Elapsed time ${elapsed}ms`)
    return json(res, result, 200)
  } catch (err) {
    Sentry.captureException(err)
    console.error('Internal server error', err)
    const body = { msg: 'Internal server error' }
    if (isDev) {
      body.detail = err.message
    }
    return json(res, body, 500)
  } finally {
    transaction.finish()
  }
})

app.get('/version', (req, res) => {
  infoLog('Handling version endpoint')
  const result = {
    gitSha,
    upstream: {
      inat: inatBaseUrl,
      inatApi: apiBaseUrl,
      inatProjectSlug,
    },
  }
  return json(res, result, 200)
})

app.listen(port, () => {
  console.log(`WOW API Facade listening on ${port}`)
})

/**
 * Get the auth header we use to make the call *to* iNat
 */
async function getOutboundAuthHeader() {
  if (outboundAuth) {
    infoLog('Using cached outbound OAuth header', outboundAuth)
    return outboundAuth
  }
  // We're using Resource Owner Password Credentials Flow.
  // Read more about this at https://www.inaturalist.org/pages/api+reference#auth
  const payload = {
    client_id: oauthAppId,
    client_secret: oauthAppSecret,
    grant_type: 'password',
    username: oauthUsername,
    password: oauthPassword,
  }
  const url = `${inatBaseUrl}/oauth/token`
  const resp = await axios.post(url, payload)
  if (resp.status !== 200) {
    throw new Error(
      `Failed to get OAuth token from iNat. Response status code=${resp.status}`,
    )
  }
  const { access_token, token_type } = resp.data || {}
  infoLog(`Getting new token, iNat OAuth response`, resp.data)
  if (!access_token || !token_type) {
    throw new Error(
      `Failed to get OAuth token from iNat. Resp status=${
        resp.status
      }, body: ${JSON.stringify(resp.data)}`,
    )
  }
  outboundAuth = `${token_type} ${access_token}`
  return outboundAuth
}

async function doGetToInat(authHeader, inboundQuerystring) {
  const url = `${apiBaseUrl}/observations`
  const params = {
    ...inboundQuerystring,
    project_id: inatProjectSlug,
  }
  try {
    const resp = await axios.get(url, {
      params,
      headers: {
        Authorization: authHeader,
      },
    })
    infoLog(`HTTP GET ${url}\n` + `  SUCCESS ${resp.status}`)
    return resp.data
  } catch (err) {
    const { status, statusText, body } = err.response || {}
    const msg =
      `HTTP GET ${url}\n` +
      `  FAILED ${status} (${statusText})\n` +
      `  Resp body: ${body}\n` +
      `  Error message: ${err.message} `
    if (err.isAxiosError) {
      throw new Error(`Axios error: ${msg}`)
    }
    console.error(msg)
    throw err
  }
}

function json(res, body, status = 200) {
  res.set('Content-type', 'application/json')
  res.status(status).send(body)
}

function getRequiredEnvVar(varName) {
  const result = process.env[varName]
  if (!result) {
    throw new Error(
      `Config error, requred env var ${varName} is not set: '${result}'`,
    )
  }
  return result
}

function infoLog(...args) {
  console.info(new Date().toISOString(), '[INFO]', ...args)
}
