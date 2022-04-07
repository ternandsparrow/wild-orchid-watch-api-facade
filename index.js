const fs = require('fs')
const fsP = require('fs/promises')
const path = require('path')
const log = {
  debug: makeLogger('DEBUG', 'log'),
  info: makeLogger('INFO', 'info'),
  warn: makeLogger('WARN', 'warn'),
  error: makeLogger('ERROR', 'error'),
}

require('dotenv').config()

const FormData = require('form-data')
const Sentry = require('@sentry/node')
const Tracing = require('@sentry/tracing')
const axios = require('axios')
const cors = require('cors')
const express = require('express')
const formidable = require('formidable')
const {CloudTasksClient} = require('@google-cloud/tasks')
const wowLib = require('./src/lib.js')

const app = express()
const port = process.env.PORT || 3000
const taskCallbackUrl = '/task-callback'
// thanks https://ihateregex.io/expr/uuid/
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/

const inatBaseUrl =
  wowLib.getUrlEnvVar('INAT_PREFIX') || 'https://dev.inat.techotom.com'
const apiBaseUrl =
  wowLib.getUrlEnvVar('INAT_API_PREFIX') || 'https://dev.api.inat.techotom.com'
const gitSha = process.env.GIT_SHA || '(nothing)'
const rootUploadDirPath = process.env.UPLOAD_DIR_PATH || './uploads'

// the WOW project. Slug is the fragment of URL, e.g. wow_project, not the
// numeric ID.
const inatProjectSlug =
  process.env.INAT_PROJECT_SLUG || 'wow-dev2'

const oauthAppId = process.env.OAUTH_APP_ID ||
  '1c0c5c9b05f181b7b59411b311c84cf4c134158e890a348cfa967e905b579c28'
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
      `Config error: API key is shorter than min length (${minKeyLength}): '${curr}'`
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
  log.warn('[WARN] No Sentry DSN provided, refusing to init Sentry client')
}

// FIXME add these to .env.example and deploy script
const gcpRegion = process.env.GCP_REGION || 'us-west1'
const gcpProject = process.env.GCP_PROJECT
const gcpQueue = process.env.GCP_QUEUE

// FIXME split code into "data producers" and "data consumers"

let outboundAuth = null

const isDev = process.env.IS_DEV_MODE !== 'false'

log.info(`WOW facade for iNat API
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
  Upload dir:     ${rootUploadDirPath}
  GCP region:     ${gcpRegion}
  GCP project:    ${gcpProject}
  GCP queue:      ${gcpQueue}
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
      log.info('Rejecting unauthorised request with API key:', apiKey)
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
    log.info('Handling request from API key:', apiKey)
    const authHeader = await getOutboundAuthHeader()
    res.set('Content-type', 'application/json')
    await streamInatGetToCaller(authHeader, req.query, res)
    const elapsed = Date.now() - startMs
    log.info(`Elapsed time ${elapsed}ms`)
    return res.status(200).end()
  } catch (err) {
    Sentry.captureException(err)
    log.error('Internal server error', err)
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

const obsGetPath = '/inat-facade/observations'
app.options(obsGetPath, cors(obsCorsOptions))

app.get(obsGetPath, (req, res) => {
  // FIXME implement endpoint for app to get observations, just a facade in
  // front of inat
  throw new Error('implement me')
})

const obsUploadPath = '/observations/:uuid'
app.options(obsUploadPath, cors(obsCorsOptions))

app.post(obsUploadPath, cors(obsCorsOptions), asyncHandler(postHandler))

async function postHandler(req) {
  const startMs = Date.now()
  const {uuid} = req.params
  if (!uuid.match(uuidRegex)) {
    return {
      status: 400,
      body: {error: `uuid path param is NOT valid`},
    }
  }
  // FIXME should we support ETag or similar to detect duplicate uploads?
  // FIXME should we roll our own resumable upload logic where the client can
  //   query how much data the server has? probably requires an endpoint to
  //   query/get upload URL and then uploads are done to that second URL. Not
  //   sure if we can do it with one request. Maybe with websockets? Don't know
  //   if service workers are aware of websockets or if they're treated the
  //   same way.
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
  let userDetail = null
  try {
    log.debug(`Checking if supplied auth is valid: ${authHeader.substr(0,20)}...`)
    const resp = await axios.get(`${apiBaseUrl}/v1/users/me`, {
      headers: { Authorization: authHeader }
    })
    log.info('Auth from observations bundle is valid', resp.status)
    userDetail = resp.data?.results[0]
  } catch (err) {
    log.info('Verifying auth passed in observations bundle has failed!', err.response.status)
    return {
      status: 401,
      body: {
        error: 'Authorization was rejected by upstream iNat server',
        upstreamError: err.response.data,
      }
    }
  }
  const uploadDirPath = await setupUploadDirForThisUuid(uuid)
  await formidableParse(uploadDirPath, req, userDetail)
  try {
    const {files, fields} = await readManifest(uploadDirPath)
    const validationError = await validate(fields, files, uuid)
    if (validationError) {
      return {
        status: 400,
        body: {message: validationError}
      }
    }
    log.info(`Parsed and validated request with ${
      Object.keys(fields).length} fields and ${Object.keys(files).length} files`)
    const callbackUrl = `${req.protocol}://${req.headers.host}${callbackUrlSuffix}`
    await scheduleGcpTask(callbackUrl)
    const extra = isDev ? {fields, files} : {}
    const callbackUrlSuffix = `${taskCallbackUrl}/${uuid}`
    return {body: {
      ...extra,
      uuid,
      callbackUrlSuffix,
      callbackUrl,
      elapsedMs: Date.now() - startMs,
    }}
  } catch (err) {
    if (err.response) {
      const {status, data} = err.response
      if (status) {
        const body = typeof data === 'string' ? data : JSON.stringify(data)
        throw new Error(`Upstream failed with status ${status} and body: ${body}`)
      }
    }
    throw err
  }
}

async function formidableParse(uploadDirPath, req, userDetail) {
  const form = formidable({
    multiples: true,
    uploadDir: uploadDirPath,
  })
  const {fields, files} = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      // FIXME does the memory usage go down after we've read the req body stream
      if (err) {
        return reject(err)
      }
      return resolve({fields, files})
    })
  })
  await fsP.writeFile(
    makeSemaphorePath(uploadDirPath),
    req.headers['authorization']
  )
  const manifest = {
    fields,
    files,
    user: {
      login: userDetail.login,
      email: userDetail.email,
    },
  }
  await fsP.writeFile(
    makeManifestPath(uploadDirPath),
    JSON.stringify(manifest)
  )
}

async function setupUploadDirForThisUuid(uuid) {
  const uploadDirPath = makeUploadDirPath(uuid)
  try {
    await fsP.access(uploadDirPath)
    log.debug(`Upload dir ${uploadDirPath} already exists, archiving...`)
    const archivePath = path.join(rootUploadDirPath, `zarchive-${uuid}.${Date.now()}`)
    await fsP.rename(uploadDirPath, archivePath)
    log.debug(`Successfully archived to ${archivePath}`)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
  }
  log.debug(`Creating empty upload dir ${uploadDirPath}...`)
  await fsP.mkdir(uploadDirPath)
  log.debug(`Upload dir ${uploadDirPath} successfully created`)
  return uploadDirPath
}

function getPhotosFromFiles(files) {
  return files.photos.constructor === Array ? files.photos : [files.photos]
}

async function uploadToInat(projectId, files, authHeader) {
  const photos = getPhotosFromFiles(files)
  log.info(`Uploading ${photos.length} photos`)
  // FIXME need to handle DELETE and adding photos to an existing obs
  const photoResps = await Promise.all(photos.map(p => {
    const form = new FormData()
    // FIXME do we need to include mime?
    const fileBytes = fs.readFileSync(p.filepath)
    form.append('file', fileBytes)
    return axios.post(
      `${apiBaseUrl}/v1/photos`,
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
  log.info(`Photo IDs from responses: ${photoIds}`)
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
  const resp = await axios.post(`${apiBaseUrl}/v1/observations`, obsBody, {
    headers: { Authorization: authHeader }
  })
  log.info(`Response to creating obs: ${resp.status}`, resp.data)
}

app.get('/version', (req, res) => {
  log.info('Handling version endpoint')
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

app.post(`${taskCallbackUrl}/:uuid`, asyncHandler(taskCallbackHandler))

async function taskCallbackHandler(req) {
  // FIXME need a shared secret for auth here
  const startMs = Date.now()
  const {uuid} = req.params // FIXME validate?
  log.debug(`Processing task callback for ${uuid}`)
  const uploadDirPath = makeUploadDirPath(uuid)
  let authHeader
  try {
    authHeader = await fsP.readFile(makeSemaphorePath(uploadDirPath))
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {body: {
        isSuccess: true,
        isProcessed: false, // it's already been processed previously
        elapsedMs: Date.now() - startMs,
      }}
    }
    throw err
  }
  const {files, fields} = await readManifest(uploadDirPath)
  // FIXME validate authHeader
  try {
    log.debug(`Uploading ${uuid} to iNat`)
    await uploadToInat(fields.projectId, files, authHeader)
    log.debug(`Successfully uploaded ${uuid} to iNat, removing semaphore`)
    await fsP.rm(makeSemaphorePath(uploadDirPath))
    log.debug(`Semaphore for ${uuid} removed`)
      return {body: {
        isSuccess: true,
        isProcessed: true,
        elapsedMs: Date.now() - startMs,
      }}
  } catch (err) {
    // FIXME might need to branch on resp code. 4xx is not worth retrying
    const isRetry = true
    // FIXME what status means retry, and which means don't bother retrying
    const status = 500
    const body = {isSuccess: false, isRetry, elapsedMs: Date.now() - startMs}
    // GCP probably doesn't care about the body, but as a dev calling the
    // endpoint, it's useful to know what happened
    return {status, body}
  }
}

;(() => { // eslint-disable-line no-extra-semi
  try {
    log.debug(`Asserting upload dir (${rootUploadDirPath}) exists`)
    const d = fs.opendirSync(rootUploadDirPath)
    d.close()
    log.debug(`Upload dir DOES exist`)
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.warn('Upload dir does NOT exist, attemping to create...')
      fs.mkdirSync(rootUploadDirPath)
      log.warn('Upload dir successfully created')
      return
    }
    if (err.code === 'ENOTDIR') {
      throw new Error(`Upload dir path ${
        rootUploadDirPath} exists, but it NOT a directory, cannot continue`)
    }
    throw err
  }
})()
app.listen(port, () => {
  log.info(`WOW API Facade listening on ${port}`)
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
    log.info('Using cached outbound auth header', outboundAuth)
    return outboundAuth
  }
  log.info('No cached outbound auth header, renewing...')
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
    try {
      const resp = await axios.post(url, payload)
      if (resp.status !== 200) {
        throw new Error(
          `Failed to get OAuth token from iNat. Response status code=${resp.status}`,
        )
      }
      log.info(`New access token, response:`, resp.data)
      const { access_token, token_type } = resp.data || {}
      if (!access_token || !token_type) {
        throw new Error('Failed to get OAuth token from iNat. Resp was ' +
          'successful, but body was missing data=' + JSON.stream(resp.data))
      }
      return `${token_type} ${access_token}`
    } catch (err) {
      throw new Error(
        `Failed to get OAuth token from iNat. Resp status=${
          err.response.status
        }, body: ${JSON.stringify(err.response.data)}`,
      )
    }
  })()
  outboundAuth = await (async () => {
    const url = `${inatBaseUrl}/users/api_token`
    log.info(
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
    log.info(`New API JWT, response:`, resp.data)
    return api_token
  })()
  log.info('Using new outbound auth header', outboundAuth)
  return outboundAuth
}

async function streamInatGetToCaller(authHeader, inboundQuerystring, res) {
  const url = `${apiBaseUrl}/v1/observations`
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
    log.info(`HTTP GET ${url}\n` + `  SUCCESS ${resp.status}`)
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
    log.error(msg)
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

function makeLogger(levelTag, fnOnConsole) {
  return function(...args) {
  console[fnOnConsole](new Date().toISOString(), `[${levelTag}]`, ...args)
}
}

async function validate(fields, files, uuid) {
  if (!files.observation) {
    return 'Must send an `observation` file containing JSON'
  }
  if (files.observation.mimetype !== 'application/json') {
    return '`observation` file must be `application/json`'
  }
  const obsRawBytes = await fsP.readFile(files.observation.filepath)
  const observation = JSON.parse(obsRawBytes)
  const obsUuid = observation.uuid
  if (obsUuid !== uuid) {
    return `UUID mismatch! "${uuid}" in URL path and "${obsUuid}" in body`
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
  // FIXME should we validate further, so HEIC, etc are disallowed?
}

function makeManifestPath(basePath) {
  return path.join(basePath, 'manifest.json')
}

async function readManifest(basePath) {
  const manifestRaw = await fsP.readFile(makeManifestPath(basePath))
  return JSON.parse(manifestRaw)
}

function makeSemaphorePath(basePath) {
  return path.join(basePath, 'semaphore.txt')
}

function makeUploadDirPath(uuid) {
  return path.join(rootUploadDirPath, uuid)
}

function asyncHandler(workerFn) {
  return function(req, res) {
    res.set('Content-type', 'application/json')
    workerFn(req)
      .then(({status, body}) => {
        return res.status(status || 200).send(body)
      })
      .catch(err => {
        // FIXME send to Sentry
        log.error(`Error while running function ${workerFn.name}`, err)
        res.status(500).send({error: 'The server exploded :('})
      })
  }
}

async function scheduleGcpTask(url) {
  if (!gcpProject || !gcpQueue) {
    log.debug('GCP queue or project config missing, refusing to schedule task')
    return
  }
  const client = new CloudTasksClient()
  const parent = client.queuePath(gcpProject, gcpRegion, gcpQueue)
  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url,
      // FIXME can we set a header in here? Or just use body?
    },
  }
  // task.httpRequest.body = Buffer.from(payload).toString('base64')
  const request = {parent: parent, task: task}
  await client.createTask(request)
}
