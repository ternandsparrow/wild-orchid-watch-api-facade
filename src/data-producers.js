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

async function _obsHandler(req, validateFn) {
  const startMs = Date.now()
  const httpMethod = req.method
  const {uuid} = req.params
  if (!uuid.match(uuidRegex)) {
    return {
      status: 400,
      body: {error: `uuid path param is NOT valid`},
    }
  }
  log.info(`Handling obs ${httpMethod} for ${uuid}`)
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
    const resp = await axios.get(`${wowConfig().apiBaseUrl}/v1/users/me`, {
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
  const {uploadDirPath, uploadSeq} = await setupUploadDirForThisUuid(uuid)
  await formidableParse(uploadDirPath, req, userDetail)
  try {
    const {files, fields} = await readManifest(uploadDirPath)
    const validationError = await validateFn(fields, files, uuid)
    if (validationError) {
      return {
        status: 400,
        body: {message: validationError}
      }
    }
    log.info(`Parsed and validated request with ${
      Object.keys(fields).length} fields and ${Object.keys(files).length} files`)
    const callbackUrlSuffix = `${taskCallbackUrl}/${uuid}/${uploadSeq}`
    const callbackUrl = (()=> {
      const protocol = wowConfig().isLocalDev ? req.protocol : 'https'
      return `${protocol}://${req.headers.host}${callbackUrlSuffix}`
    })()
    log.debug(`Callback URL will be: ${httpMethod} ${callbackUrl}`)
    await scheduleGcpTask(httpMethod, callbackUrl)
    const extra = wowConfig().isLocalDev ? {fields, files} : {}
    const elapsedMs = Date.now() - startMs
    log.info(`Elapsed ${elapsedMs}ms`)
    return {body: {
      ...extra,
      uuid,
      callbackMethod: httpMethod,
      callbackUrlSuffix,
      callbackUrl,
      elapsedMs,
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
  const seq = Date.now()
  const uploadDirPath = makeUploadDirPath(uuid, seq)
  try {
    await fsP.access(uploadDirPath)
    // FIXME we shouldn't have collisions, but we could iterate until we find a
    // dir name that is not taken
    throw new Error('Upload dir collision')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
  }
  log.debug(`Creating empty upload dir ${uploadDirPath}...`)
  await fsP.mkdir(uploadDirPath)
  log.debug(`Upload dir ${uploadDirPath} successfully created`)
  return {uploadDirPath, uploadSeq: seq}
}

function asyncHandler(workerFn, ...extraParams) {
  return function(req, res) {
    res.set('Content-type', 'application/json')
    workerFn(req, ...extraParams)
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

// according to https://cloud.google.com/tasks/docs/tutorial-gcf
// > Any status code other than 2xx or 503 will trigger the task to retry
async function _taskCallbackHandler(req, sendToUpstreamFn) {
  // FIXME need a shared secret for auth here
  const startMs = Date.now()
  const {uuid, seq} = req.params // FIXME validate?
  log.info(`Processing task callback for ${uuid}, seq=${seq}`)
  const uploadDirPath = makeUploadDirPath(uuid, seq)
  let authHeader
  const semaphorePath = makeSemaphorePath(uploadDirPath)
  try {
    log.debug(`Reading auth header for ${uuid}`)
    authHeader = await fsP.readFile(semaphorePath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {body: {
        isSuccess: true,
        wasProcessed: false, // it's already been processed previously
        elapsedMs: Date.now() - startMs,
      }}
    }
    throw err
  }
  log.debug(`Reading manifest for ${uuid}`)
  const {files, fields} = await readManifest(uploadDirPath)
  // FIXME validate authHeader
  try {
    log.debug(`Uploading ${uuid} to iNat`)
    const upstreamRespBody = await sendToUpstreamFn(fields, files, authHeader)
    const upstreamRespBodyPath = path.join(uploadDirPath, 'new-obs.json')
    log.debug(`Writing upstream resp body to file: ${upstreamRespBodyPath}`)
    await fsP.writeFile(upstreamRespBodyPath, JSON.stringify(upstreamRespBody))
    log.debug(`Upstream resp body written, removing semaphore for ${uuid}`)
    await fsP.rm(semaphorePath)
    log.debug(`Semaphore for ${uuid} removed`)
    const elapsedMs = Date.now() - startMs
    log.info(`Successfully processed ${uuid}; ID=${upstreamRespBody.id}; took ${elapsedMs}ms`)
    return {body: {
      isSuccess: true,
      wasProcessed: true,
      elapsedMs,
    }}
  } catch (err) {
    log.error('Failed to upload to iNat', err)
    // FIXME might need to branch on resp code. 4xx is not worth retrying
    // FIXME how do we tell GCP Tasks to *not* retry? Explicitly remove the
    // task from the queue or just return success and raise the alarm
    // elsewhere?
    const canRetry = true // FIXME compute this
    const status = 500 // FIXME
    const body = {isSuccess: false, canRetry, elapsedMs: Date.now() - startMs}
    // GCP probably doesn't care about the body, but as a dev calling the
    // endpoint, it's useful to know what happened
    return {status, body}
  }
}

function validatePost(fields, files, uuid) {
  if (!fields.projectId) {
    return 'Must send a `projectId` numeric field'
  }
  if (isNaN(fields.projectId)) {
    return '`projectId` must be a numeric field'
  }
  if (!files.photos) {
    return 'Must send `photos` field'
  }
  return _validate(fields, files, uuid)
}

function validatePut(...params) {
  // FIXME validate photo IDs to delete
  // FIXME validate obs field IDs to delete
  return _validate(...params)
}

async function _validate(fields, files, uuid) {
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
  const photos = getPhotosFromFiles(files)
  if (!photos.every(e => e.mimetype.startsWith('image/'))) {
    return 'All `photos` files must have a `image/*` mime'
  }
  // FIXME should we validate further, so HEIC, etc are disallowed?
}

function getPhotosFromFiles(files) {
  const photos = files.photos
  if (!photos) {
    return []
  }
  return photos.constructor === Array ? files.photos : [files.photos]
}

async function createInatObs({projectId}, files, authHeader) {
  const photos = getPhotosFromFiles(files)
  log.debug(`Uploading ${photos.length} photos`)
  const photoResps = await Promise.all(photos.map(p => {
    const form = new FormData()
    const fileStream = fs.createReadStream(p.filepath)
    form.append('file', fileStream, {
      filename: p.originalFilename,
      contentType: p.mimetype,
      knownLength: p.size,
    })
    return axios.post(
      `${wowConfig().apiBaseUrl}/v1/photos`,
      form,
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
  log.debug(`Photo IDs from responses: ${photoIds}`)
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
  const resp = await axios.post(`${wowConfig().apiBaseUrl}/v1/observations`, obsBody, {
    headers: { Authorization: authHeader }
  })
  log.debug(`iNat response status for ${obsJson.uuid}: ${resp.status}`)
  return resp.data
}

async function updateInatObs(fields, files, authHeader) {
  const obsJson = JSON.parse(fs.readFileSync(files.observation.filepath))
  const inatRecordId = obsJson.id
  if (!inatRecordId) {
    log.error('Dumping observation JSON for error', obsJson)
    throw new Error(`Could not find inat ID`)
  }
  const photos = getPhotosFromFiles(files)
  log.debug(`Processing ${photos.length} photos`)
  await Promise.all(photos.map(p => {
    const form = new FormData()
    const fileStream = fs.createReadStream(p.filepath)
    form.append('observation_photo[observation_id]', inatRecordId)
    form.append('file', fileStream, {
      filename: p.originalFilename,
      contentType: p.mimetype,
      knownLength: p.size,
    })
    return axios.post(
      `${wowConfig().apiBaseUrl}/v1/observation_photos`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: authHeader,
        }
      }
    )
  }))
  const photoIdsToDelete = JSON.parse(fields['photos-delete'])
  await Promise.all(photoIdsToDelete.map(id => {
    log.debug(`Deleting photo ${id}`)
    return axios.delete(
      `${wowConfig().apiBaseUrl}/v1/observation_photos/${id}`,
      { headers: { Authorization: authHeader } }
    )
  }))
  const obsFieldIdsToDelete = JSON.parse(fields['obsFields-delete'])
  await Promise.all(obsFieldIdsToDelete.map(id => {
    log.debug(`Deleting obs field ${id}`)
    return axios.delete(
      `${wowConfig().apiBaseUrl}/v1/observation_field_values/${id}`,
      { headers: { Authorization: authHeader } }
    )
  }))
  log.debug(`Updating observation with ID=${inatRecordId}`)
  const resp = await axios.put(
    `${wowConfig().apiBaseUrl}/v1/observations/${inatRecordId}`,
    {
      // note: obs fields *not* included here are *not* implicitly deleted.
      observation: obsJson,
      ignore_photos: true,
    },
    { headers: { Authorization: authHeader } }
  )
  log.debug(`iNat response status for ${inatRecordId}: ${resp.status}`)
  return resp.data
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

function makeUploadDirPath(uuid, seq) {
  return path.join(wowConfig().rootUploadDirPath, `${uuid}.${seq}`)
}

async function scheduleGcpTask(httpMethod, url) {
  if (!wowConfig().gcpProject || !wowConfig().gcpQueue) {
    log.debug('GCP queue or project config missing, refusing to schedule ' +
      'task. Call it yourself by hand with curl.')
    return
  }
  const client = new CloudTasksClient()
  const parent = client.queuePath(
    wowConfig().gcpProject,
    wowConfig().gcpRegion,
    wowConfig().gcpQueue
  )
  const task = {
    httpRequest: {
      httpMethod,
      url,
      // FIXME can we set a header in here? Or just use body?
    },
  }
  log.debug(`Scheduling callback task for ${url}`)
  const request = {parent: parent, task: task}
  await client.createTask(request)
  log.debug('Task scheduled')
}

module.exports = {
  obsPostHandler: asyncHandler(_obsHandler, validatePost),
  obsPutHandler: asyncHandler(_obsHandler, validatePut),
  taskCallbackPostHandler: asyncHandler(_taskCallbackHandler, createInatObs),
  taskCallbackPutHandler: asyncHandler(_taskCallbackHandler, updateInatObs),
}
