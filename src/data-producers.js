// code related to servicing our data producers: folks out in the field making
// observations using the app
const fs = require('fs')
const fsP = require('fs/promises')
const path = require('path')

const axios = require('axios')
const FormData = require('form-data')
const formidable = require('formidable')
const {CloudTasksClient} = require('@google-cloud/tasks')
const {log, wowConfig} = require('./lib.js')
const {taskCallbackUrl} = require('./routes.js')

// thanks https://ihateregex.io/expr/uuid/
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/

async function _obsPostHandler(req) {
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
    const resp = await axios.get(`${wowConfig.apiBaseUrl}/v1/users/me`, {
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
    const callbackUrlSuffix = `${taskCallbackUrl}/${uuid}`
    const callbackUrl = `${req.protocol}://${req.headers.host}${callbackUrlSuffix}`
    await scheduleGcpTask(callbackUrl)
    const extra = wowConfig.isDev ? {fields, files} : {}
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

async function _obsGetHandler(req) {
  // FIXME implement endpoint for app to get observations, just a facade in
  // front of inat. Do we actually need this, or is it safe to keep going
  // direct to inat?
  throw new Error('implement me')
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
    const archivePath = path.join(wowConfig.rootUploadDirPath, `zarchive-${uuid}.${Date.now()}`)
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

async function _taskCallbackHandler(req) {
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
      `${wowConfig.apiBaseUrl}/v1/photos`,
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
  const resp = await axios.post(`${wowConfig.apiBaseUrl}/v1/observations`, obsBody, {
    headers: { Authorization: authHeader }
  })
  log.info(`Response to creating obs: ${resp.status}`, resp.data)
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
  return path.join(wowConfig.rootUploadDirPath, uuid)
}

async function scheduleGcpTask(url) {
  if (!wowConfig.gcpProject || !wowConfig.gcpQueue) {
    log.debug('GCP queue or project config missing, refusing to schedule ' +
      'task. Call it yourself by hand with curl.')
    return
  }
  const client = new CloudTasksClient()
  const parent = client.queuePath(
    wowConfig.gcpProject,
    wowConfig.gcpRegion,
    wowConfig.gcpQueue
  )
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

module.exports = {
  obsGetHandler: asyncHandler(_obsGetHandler),
  obsPostHandler: asyncHandler(_obsPostHandler),
  taskCallbackHandler: asyncHandler(_taskCallbackHandler),
}
