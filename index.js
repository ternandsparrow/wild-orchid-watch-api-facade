const axios = require('axios')
const wowLib = require('./src/lib.js')

const apiBaseUrl = wowLib.stripTrailingSlashes(
  getRequiredEnvVar('INAT_API_PREFIX'),
)
const inatBaseUrl = wowLib.stripTrailingSlashes(
  getRequiredEnvVar('INAT_PREFIX'),
)

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
// compute some metrics on who is calling. The keys can be any string, they're just opaque tokens. Make sure they're
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

let outboundAuth = null

const isDev = process.env.IS_DEV_MODE === 'true'
console.info(`WOW facade for iNat API
  Target API:   ${apiBaseUrl}
  Project slug: ${inatProjectSlug}
  API Keys:     ${JSON.stringify(allApiKeys)}
  OAuth App ID: ${oauthAppId}
  OAuth Secret: ${oauthAppSecret}
  OAuth user:   ${oauthUsername}
  OAuth pass:   ${oauthPassword}
  Dev mode:     ${isDev}`)

exports.doFacade = async (req, res) => {
  try {
    const startMs = Date.now()
    res.set('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') {
      debugLog('Handling CORS preflight')
      // CORS enabled!
      res.set('Access-Control-Allow-Methods', 'GET')
      res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
      res.set('Access-Control-Max-Age', '3600')
      return res.status(204).send('')
    }
    if (req.method !== 'GET') {
      debugLog('Rejecting non-GET request')
      const methodNotAllowed = 405
      return json(
        res,
        { msg: 'METHOD NOT ALLOWED', status: methodNotAllowed },
        methodNotAllowed,
      )
    }
    const path = req.path
    if (path !== '/wow-observations') {
      debugLog('Rejecting unhandled path:', path)
      const notFound = 404
      return json(res, { msg: 'NOT FOUND', status: notFound }, notFound)
    }
    const apiKey = req.headers.authorization
    const isAuthorised = allApiKeys.includes(apiKey)
    if (!isAuthorised) {
      debugLog('Rejecting unauthorised request with API key:', apiKey)
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
    debugLog('Handling request from API key:', apiKey)
    const authHeader = await getOutboundAuthHeader()
    const result = await doGetToInat(authHeader, req.query)
    const elapsed = Date.now() - startMs
    debugLog(`Elapsed time ${elapsed}ms`)
    return json(res, result, 200)
  } catch (err) {
    // FIXME report to Sentry
    console.error('Internal server error', err)
    const body = { msg: 'Internal server error' }
    if (isDev) {
      body.detail = err.message
    }
    return json(res, body, 500)
  }
}

/**
 * Get the auth header we use to make the call *to* iNat
 */
async function getOutboundAuthHeader() {
  if (outboundAuth) {
    debugLog('Using cached outbound OAuth header', outboundAuth)
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
  debugLog(`Getting new token, iNat OAuth response`, resp.data)
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
    debugLog(`HTTP GET ${url}\n` + `  SUCCESS ${resp.status}`)
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

function debugLog(...args) {
  if (!isDev) {
    return
  }
  console.debug(new Date().toISOString(), '[DEBUG]', ...args)
}
