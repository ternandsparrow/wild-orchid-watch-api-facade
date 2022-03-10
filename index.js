const fs = require('fs')
const fsP = require('fs/promises')
const express = require('express')
const axios = require('axios')
const wowLib = require('./src/lib.js')
const Sentry = require('@sentry/node')
const Tracing = require('@sentry/tracing')
const formidable = require('formidable')
const cors = require('cors')
const FormData = require('form-data')

const app = express()
const port = process.env.PORT || 3000

const apiBaseUrl = wowLib.stripTrailingSlashes(
  getRequiredEnvVar('INAT_API_PREFIX'),
)
const inatBaseUrl = wowLib.stripTrailingSlashes(
  getRequiredEnvVar('INAT_PREFIX'),
)
const apiUrl = 'https://dev.api.inat.techotom.com' // FIXME make config

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
    res.set('Content-type', 'application/json')
    await streamInatGetToCaller(authHeader, req.query, res)
    const elapsed = Date.now() - startMs
    infoLog(`Elapsed time ${elapsed}ms`)
    return res.status(200).end()
  } catch (err) {
    Sentry.captureException(err)
    console.error('Internal server error', err)
    const body = { msg: 'Internal server error' }
    if (isDev) {
      body.devDetail = err.message
    }
    return json(res, body, 500)
  } finally {
    transaction.finish()
  }
})

const obsCorsOptions = {methods: ['POST']}
app.options('/observations', cors(obsCorsOptions))

app.post('/observations', cors(obsCorsOptions), (req, res) => {
  res.set('Content-type', 'application/json')
  postHandler(req)
    .then(({status, body}) => {
      return res.status(status || 200).send(body)
    })
    .catch(err => {
      // FIXME send to Sentry
      console.error('Error while handling POST /observations', err)
      res.status(500).send({error: 'The server exploded :('})
    })
})

async function postHandler(req) {
  // FIXME should we support ETag to detect duplicate uploads?
  const expectedContentType = 'multipart/form-data'
  const isNotMultipart = !~(req.headers['content-type'] || '')
    .indexOf(expectedContentType)
  if (isNotMultipart) {
    return {
      status: 415,
      body: {error: `Can only handle ${expectedContentType}`}
    }
  }
  const authHeader = req.headers['authorization']
  // FIXME could check it looks like a JWT
  if (!authHeader) {
    return {
      status: 401,
      body: {error: `Authorization must be provided`}
    }
  }
  try {
    console.log(`Checking if supplied auth is valid: ${authHeader.substr(0,20)}...`)
    const resp = await axios.get(`${apiUrl}/v1/users/me`, {
      headers: { Authorization: authHeader }
    })
    infoLog('Auth from observations bundle is valid', resp.status)
  } catch (err) {
    infoLog('Verifying auth passed in observations bundle has failed!', err.response.status)
    return {
      status: 401,
      body: {
        error: 'Authorization was rejected by upstream iNat server',
        upstreamError: err.response.data,
      }
    }
  }
  // FIXME try to parse files without writing to disk, just keep in memory
  const form = formidable({ multiples: true })
  const {fields, files} = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) {
        return reject(err)
      }
      return resolve({fields, files})
    })
  })
  try {
    const validationError = validate(fields, files)
    if (validationError) {
      return {
        status: 400,
        body: {message: validationError}
      }
    }
    infoLog(`Handling request with ${Object.keys(fields).length} fields and ${
      Object.keys(files).length} files`)
    // FIXME should be async and triggered again if this server fails (durable trigger)
    await uploadToInat(fields.projectId, files, authHeader)
    // FIXME handle errors?
    // FIXME respond to caller once files are saved (to GCP) and req is queued
    return {body: { fields, files }} // FIXME
  } catch (err) {
    if (err.response) {
      const {status, data} = err.response
      if (status) {
        const body = typeof data === 'string' ? data : JSON.stringify(data)
        throw new Error(`Upstream failed with status ${status} and body: ${body}`)
      }
    }
    throw err
  } finally {
    await cleanup(files)
  }
}

function getPhotosFromFiles(files) {
  return files.photos.constructor === Array ? files.photos : [files.photos]
}

async function uploadToInat(projectId, files, authHeader) {
  const photos = getPhotosFromFiles(files)
  infoLog(`Uploading ${photos.length} photos`)
  // FIXME need to handle DELETE and adding photos to an existing obs
  const photoResps = await Promise.all(photos.map(p => {
    const form = new FormData()
    // FIXME do we need to include mime?
    const fileBytes = fs.readFileSync(p.filepath)
    form.append('file', fileBytes)
    return axios.post(
      `${apiUrl}/v1/photos`,
      form.getBuffer(),
      {
        headers: {
          ...form.getHeaders(),
          Authorization: authHeader,
        }
      }
    )
  }))
  // FIXME catch image post error, like an image/* that iNat doesn't like
  const photoIds = photoResps.map(e => e.data.id)
  infoLog(`Photo IDs from responses: ${photoIds}`)
  const obsJson = JSON.parse(fs.readFileSync(files.observation.filepath))
  const obsBody = {
    observation: obsJson,
    local_photos: {
      0: photoIds,
    },
    uploader: true,
    refresh_index: true,
    project_id: [
      projectId,
    ]
  }
  const resp = await axios.post(`${apiUrl}/v1/observations`, obsBody, {
    headers: { Authorization: authHeader }
  })
  infoLog(`Response to creating obs: ${resp.status}`, resp.data)
}

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

function processStreamChunks(stream, chunkCallback) {
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => {
      try {
        chunkCallback(chunk)
      } catch (err) {
        return reject(err)
      }
    })
    stream.on('end', resolve)
    stream.on('error', reject)
  })
}

/**
 * Get the auth header we use to make the call *to* iNat
 */
async function getOutboundAuthHeader() {
  if (outboundAuth) {
    infoLog('Using cached outbound auth header', outboundAuth)
    return outboundAuth
  }
  infoLog('No cached outbound auth header, renewing...')
  const accessTokenHeader = await (async () => {
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
    infoLog(`New access token, response:`, resp.data)
    const { access_token, token_type } = resp.data || {}
    if (!access_token || !token_type) {
      throw new Error(
        `Failed to get OAuth token from iNat. Resp status=${
          resp.status
        }, body: ${JSON.stringify(resp.data)}`,
      )
    }
    return `${token_type} ${access_token}`
  })()
  outboundAuth = await (async () => {
    const url = `${inatBaseUrl}/users/api_token`
    infoLog(
      `Exchanging access token (${accessTokenHeader}) for API JWT at URL=${url}`,
    )
    const resp = await axios.get(url, {
      headers: {
        Authorization: accessTokenHeader,
      },
    })
    if (resp.status !== 200) {
      throw new Error(
        `Failed to get API JWT from iNat. Response status code=${resp.status}`,
      )
    }
    const { api_token } = resp.data || {}
    if (!api_token) {
      throw new Error(
        `Failed to get API JWT from iNat. Status (${
          resp.status
        }) was OK but didn't find the JWT in the repsonse: ${JSON.stringify(
          resp.data,
        )}`,
      )
    }
    infoLog(`New API JWT, response:`, resp.data)
    return api_token
  })()
  infoLog('Using new outbound auth header', outboundAuth)
  return outboundAuth
}

async function streamInatGetToCaller(authHeader, inboundQuerystring, res) {
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
      responseType: 'stream',
    })
    infoLog(`HTTP GET ${url}\n` + `  SUCCESS ${resp.status}`)
    await processStreamChunks(resp.data, (
      chunk /* chunk is an ArrayBuffer */,
    ) => {
      res.write(new Buffer.from(chunk))
    })
  } catch (err) {
    const { status, statusText, body } = await (async () => {
      const r = err.response
      if (!r) {
        return {}
      }
      const chunks = []
      await processStreamChunks(r.data, chunk => chunks.push(chunk))
      // thanks https://stackoverflow.com/a/49428486/1410035
      const body = Buffer.concat(chunks).toString('utf8')
      return {
        status: r.status,
        statusText: r.statusText,
        body,
      }
    })()
    const msg =
      `HTTP GET ${url}\n` +
      `  FAILED ${status} (${statusText})\n` +
      `  Resp body: ${body}\n` +
      `  Error message: ${err.message} `
    if (err.isAxiosError && isDev) {
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

function validate(fields, files) {
  if (!files.observation) {
    return 'Must send an `observation` file containing JSON'
  }
  if (files.observation.mimetype !== 'application/json') {
    return '`observation` file must be `application/json`'
  }
  if (!fields.projectId) {
    return 'Must send a `projectId` numeric field'
  }
  if (isNaN(fields.projectId)) {
    return '`projectId` must be a numeric field'
  }
  if (!files.photos) {
    return 'Must send `photos` field'
  }
  const photos = getPhotosFromFiles(files)
  if (!photos.every(e => e.mimetype.startsWith('image/'))) {
    return 'All `photos` files must have a `image/*` mime'
  }
  // FIXME add other checks
}

function cleanup(files) {
  return Promise.all(Object.values(files).map(curr => {
    if (curr.constructor === Array) {
      return Promise.all(curr.map(e => fsP.rm(e.filepath)))
    }
    return fsP.rm(curr.filepath)
  }))
}
