const axios = require('axios')

const apiBaseUrl = (() => {
  const val = process.env.INAT_API_PREFIX
  if (!val) {
    throw new Error('Config error, INAT_API_PREFIX env var is not set')
  }
  return val.replace(/\/*$/, '')
})()

// these are keys we issue for clients to call us
const allApiKeys = [
  // FIXME add more clients
  getRequiredEnvVar('CLIENT1_API_KEY'),
]

// FIXME how do we version this API?
//   - x-version header, defaulting to newest
// FIXME should we return the version in the resp

// FIXME what credentials can we set here that won't expire?
//   - JWT only lives for 24hrs
//   - Bearer token lives for 30 days
//   - might have to be user/pass
// Do we have to mint a new token everytime? Are there rate limits on this?
const outboundAuth = null

const isDev = process.env.IS_DEV_MODE === 'true'
console.info(`WOW facade for iNat API
  Target API: ${apiBaseUrl}
  API Keys:   ${JSON.stringify(allApiKeys)}
  Dev mode:   ${isDev}`)

exports.doFacade = async (req, res) => {
  try {
    const startMs = Date.now()

    res.set('Access-Control-Allow-Origin', '*')

    if (req.method === 'OPTIONS') {
      // CORS enabled!
      res.set('Access-Control-Allow-Methods', 'GET')
      res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
      res.set('Access-Control-Max-Age', '3600')
      res.status(204).send('')
      return
    } else if (req.path !== '/observations') {
      const notFound = 404
      return json(res, { msg: 'NOT FOUND', status: notFound }, notFound)
    } else if (req.method !== 'GET') {
      const methodNotAllowed = 405
      return json(
        res,
        { msg: 'METHOD NOT ALLOWED', status: methodNotAllowed },
        methodNotAllowed,
      )
    }
    const urlSuffix = req.url
    const apiKey = req.headers.authorization
    const isAuthorised = allApiKeys.includes(apiKey)
    if (!isAuthorised) {
      const forbidden = 403
      return json(
        res,
        {
          msg: 'API key (passed via Authorization header) missing or not valid',
          status: forbidden,
        },
        forbidden,
      )
    }
    const authHeader = await getAuthHeader()

    const result = await doGet(urlSuffix, authHeader)
    const elapsed = Date.now() - startMs
    console.debug(`Elapsed time ${elapsed}ms`)

    return json(res, result, 200)
  } catch (err) {
    console.error('Internal server error', err)
    const body = { msg: 'Internal server error' }
    if (isDev) {
      body.detail = err.message
    }
    return json(res, body, 500)
  }
}

async function getAuthHeader() {
  // FIXME need to use env var credentials to get a JWT
  return 'abc123'
}

async function doGet(urlSuffix, authHeader) {
  return { msg: 'shortcut', urlSuffix, authHeader } // FIXME remove
  const url = `${apiBaseUrl}/${urlSuffix}`
  try {
    const result = await axios.get(url, {
      headers: {
        Authorization: authHeader,
      },
    })
    console.debug(`HTTP GET ${url}\n` + `  SUCCESS ${result.status}`)
    return result
  } catch (err) {
    const msg =
      `HTTP GET ${url}\n` +
      `  FAILED ${err.response.status} (${err.response.statusText})\n` +
      `  Resp body: ${respBody}`
    if (err.isAxiosError) {
      throw new Error(`Axios error: ${msg}`)
    }
    console.error(msg)
    // FIXME log to error tracker
    throw err
  }
}

function json(res, body, status = 200) {
  res.set('Content-type', 'application/json')
  res.status(status).send(body)
}

function chainedError(msg, err) {
  // FIXME add proper error chaining
  const newMsg = `${msg}\nCaused by: ${err.message}`
  err.message = newMsg
  return err
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
