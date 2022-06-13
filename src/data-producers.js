// code related to servicing our data producers: folks out in the field making
// observations using the app
const fs = require('fs')
const fsP = require('fs/promises')
const path = require('path')

const realAxios = require('axios')
const FormData = require('form-data')
const formidable = require('formidable')
const betterSqlite3 = require('better-sqlite3')

const {CloudTasksClient} = require('@google-cloud/tasks')
const {
  log,
  taskCallbackUrlPrefix,
  taskStatusUrlPrefix,
  wowConfig,
} = require('./lib.js')

const dbPath = process.env.DB_PATH || path.join(wowConfig().rootUploadDirPath, 'data.db')

const getDb = (() => {
  let instance = null
  return function() {
    if (!instance) {
      log.debug('Creating new sqlite client')
      instance = betterSqlite3(dbPath)
      process.on('exit', () => {
        console.debug('Closing sqlite connection')
        instance.close()
      })
    }
    return instance
  }
})()

async function _obsTaskStatusHandler(req) {
  // FIXME need auth here because we return sensitive data
  const {uuid} = req.params
  if (!isUuid(uuid)) {
    return {
      status: 400,
      body: {error: `uuid path param is NOT valid`},
    }
  }
  const {seq, status} = getLatestUploadRecord(uuid)
  const uploadDirPath = makeUploadDirPath(uuid, seq)
  if (!(await isPathExists(uploadDirPath))) {
    return {
      status: 404,
      body: {error: `uuid has no tasks`},
    }
  }
  const upstreamBody = await (() => {
    if (status !== 'success') {
      return
    }
    const upstreamRespBodyPath = makeUpstreamBodyPath(uploadDirPath)
    return readJsonFile(upstreamRespBodyPath)
  })()
  return {body: {
    taskStatus: status,
    upstreamBody,
    req: {
      uuid,
    },
  }}
}

async function _obsDeleteStatusHandler(req, {axios, apiBaseUrl}) {
  // not enforcing auth because we don't provide any sensitive data; anyone can
  // see if an observation exists
  const inatId = parseInt(req.params.inatId)
  // FIXME validate param
  const resp = await axios.get(`${apiBaseUrl}/v1/observations/${inatId}`)
  const totalResults = resp.data.total_results
  const taskStatus = totalResults > 0 ? 'processing' : 'success'
  // FIXME is there a possible 'failure' status? How would we check? I don't
  //  think there is because the client sends the delete direct to iNat, so we
  //  can only have an error here, which does *not* indicate failure, just that
  //  the client should try later.
  return {body: {
    taskStatus,
    totalResults,
  }}
}

async function obsHandler(req, { isLocalDev }) {
  const {uuid} = req.params
  if (!isUuid(uuid)) {
    return {
      status: 400,
      body: {error: `uuid path param is NOT valid`},
    }
  }
  log.info(`Handling obs ${uuid}`)
  // FIXME should we support ETag or similar to detect duplicate uploads?
  // FIXME should we roll our own resumable upload logic where the client can
  //   query how much data the server has? probably requires an endpoint to
  //   query/get upload URL and then uploads are done to that second URL. Not
  //   sure if we can do it with one request. Maybe with websockets? Don't know
  //   if service workers are aware of websockets or if they're treated the
  //   same way.
  const expectedContentType = 'multipart/form-data'
  const isNotMultipart = (req.headers['content-type'] || '')
    .indexOf(expectedContentType) < 0
  if (isNotMultipart) {
    return {
      status: 415,
      body: {error: `Can only handle ${expectedContentType}`}
    }
  }
  let { userDetail } = req
  const { uploadDirPath, seq } = await setupUploadDirForThisUuid(uuid)
  const form = formidable({
    multiples: true,
    uploadDir: uploadDirPath,
  })
  const {fields, files} = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) {
        return reject(err)
      }
      return resolve({fields, files})
    })
  })
  const validationResp = await validate(fields, files, uuid)
  if (!validationResp.isSuccess) {
    return {
      status: 400,
      body: {message: validationResp}
    }
  }
  log.info(`Parsed and validated request with ${
    Object.keys(fields).length} fields and ${Object.keys(files).length} files`)
  const db = getDb()
  const t = db.transaction(() => {
    const {changes} = db.prepare(`
      UPDATE uploads
      SET status = 'superseded'
      WHERE uuid = ?
      AND status = 'pending'
    `).run(uuid)
    log.debug(`Marked ${changes} old ${uuid} records as superseded`)
    log.debug(`Creating upload record for ${uuid}`)
    const {lastInsertRowid} = db.prepare(`
      INSERT INTO uploads (
        uuid, inatId, projectId, user, obsJsonPath, apiToken, status, seq, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, datetime())
    `)
    .run(
      uuid,
      validationResp.inatId,
      fields.projectId,
      userDetail.login,
      files.observation.filepath,
      req.headers['authorization'],
      seq,
    )
    const {uploadId} = db
      .prepare('SELECT uploadId FROM uploads WHERE rowid = ?')
      .get(lastInsertRowid)
    log.debug(`upload for ${uuid} has id=${uploadId}`)
    const stmt = db.prepare(
      'INSERT INTO photos (size, filepath, mimetype, uploadId) ' +
      'VALUES (?, ?, ?, ?)'
    )
    files.photos.forEach(p => {
      log.debug(`Creating photo record for ${p.filepath}`)
      stmt.run(p.size, p.filepath, p.mimetype, uploadId)
    })
  })
  t()
  const serverUrlPrefix = (()=> {
    const protocol = isLocalDev ? req.protocol : 'https'
    return `${protocol}://${req.headers.host}`
  })()
  const callbackMethod = 'POST'
  const callbackUrl = `${serverUrlPrefix}${taskCallbackUrlPrefix}/${uuid}`
  log.debug(`Callback URL will be: ${callbackMethod} ${callbackUrl}`)
  const statusUrl = `${serverUrlPrefix}${taskStatusUrlPrefix}/${uuid}`
  log.debug(`Status URL will be: GET ${statusUrl}`)
  await scheduleGcpTask(callbackUrl)
  const extra = isLocalDev ? {fields, files} : {}
  return {body: {
    ...extra,
    uuid,
    statusUrl,
    queuedTaskDetails: {
      callbackMethod,
      callbackUrl,
    },
  }}
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
  return {uploadDirPath, seq}
}

function asyncHandler(workerFn, extraParams) {
  return function(req, res) {
    const startMs = Date.now()
    res.set('Content-type', 'application/json')
    const wowContext = {
      axios: realAxios,
      ...wowConfig(),
      ...extraParams,
    }
    wowContext.dispatch = (fnName, ...args) => {
      const dispatchables = {
        createInatObs,
        updateInatObs,
      }
      return dispatchables[fnName](wowContext, ...args)
    }
    workerFn(req, wowContext)
      .then(({status, body}) => {
        const elapsedMs = Date.now() - startMs
        const respBody = {
          ...body,
          elapsedMs,
        }
        log.debug(`${workerFn.name} elapsed ${elapsedMs}ms`)
        return res.status(status || 200).send(respBody)
      })
      .catch(err => {
        // FIXME send to Sentry
        log.error(`Error while running function ${workerFn.name}`, err)
        res.status(500).send({error: 'The server exploded :('})
      })
  }
}

function getLatestUploadRecord(uuid) {
  const result = getDb().prepare(`
    SELECT uploadId, status, seq, inatId
    FROM uploads
    WHERE uuid = @uuid
    AND updatedAt = (
      SELECT max(updatedAt)
      FROM uploads
      WHERE uuid = @uuid
    )
  `).get({uuid})
  return result || {}
}

// according to https://cloud.google.com/tasks/docs/tutorial-gcf
// > Any status code other than 2xx or 503 will trigger the task to retry
async function _taskCallbackHandler(req, { dispatch }) {
  // FIXME need a shared secret for auth here
  const {uuid} = req.params // FIXME validate?
  log.info(`Processing task callback for ${uuid}`)
  const { uploadId, status, seq, inatId } = getLatestUploadRecord(uuid)
  if (!status) {
    return {status: 404, body: {msg: `${uuid} not found`}}
  }
  const isAlreadyProcessed = ['success', 'failure'].includes(status)
  if (isAlreadyProcessed) {
    return {body: {
      isSuccess: true,
      wasProcessed: false, // it's already been processed previously
    }}
  }
  const uploadDirPath = makeUploadDirPath(uuid, seq)
  try {
    log.debug(`Uploading ${uuid} to iNat`)
    const isUpdate = !!inatId
    const sendToUpstreamFnName = isUpdate ? updateInatObs.name : createInatObs.name
    const upstreamRespBody = await dispatch(sendToUpstreamFnName)
    const upstreamRespBodyPath = makeUpstreamBodyPath(uploadDirPath)
    log.debug(`Writing upstream resp body to file: ${upstreamRespBodyPath}`)
    await fsP.writeFile(upstreamRespBodyPath, JSON.stringify(upstreamRespBody))
    log.debug(`Upstream resp body written, cleaning up for ${uuid}`)
    getDb().prepare(`
      UPDATE uploads
      SET
        apiToken = NULL,
        status = 'success',
        updatedAt = datetime()
      WHERE uploadId = ?
    `).run(uploadId)
    log.info(`Successfully processed ${uuid}; ID=${upstreamRespBody.id}`)
    return {body: {
      isSuccess: true,
      wasProcessed: true,
    }}
  } catch (err) {
    const upstreamStatus = (err.response || {}).status
    const errorLogPath = makeErrorLogPath(uploadDirPath)
    const errDump = err.stack || err.msg
    await fsP.appendFile(
      errorLogPath,
      `[${new Date().toISOString()}] Status=${upstreamStatus}; err=${errDump}\n`,
    )
    if (upstreamStatus) {
      log.error(
        `Failed to upload to iNat with status=${upstreamStatus}.`,
        err.response.data,
      )
    } else {
      log.error('Failed to upload to iNat', err)
    }
    // FIXME how do we know when retries have been exhausted?
    const isTerminalFailure = upstreamStatus === 401
    if (isTerminalFailure) {
      // FIXME remove apiToken from record
      // FIXME update record status
      const status = 200 // not success as such, but the task cannot be retried
      const noRetryMsg = 'Above error was terminal, task will not be retried\n'
      await fsP.appendFile(errorLogPath, noRetryMsg)
      console.warn(noRetryMsg)
      return {status, body: {isSuccess: false, canRetry: false}}
    }
    const status = 500 // will cause GCP Tasks to retry
    // GCP probably doesn't care about the body, but as a dev calling the
    // endpoint, it's useful to know what happened
    return {status, body: {isSuccess: false, canRetry: true}}
  }
}

async function isPathExists(thePath) {
  try {
    await fsP.access(thePath)
    return true
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
    return false
  }
}

function _validateCreate(fields, files) {
  if (!fields.projectId) {
    return '"projectId" must be a positive integer'
  }
  if (!/^\d+$/.test(fields.projectId)) {
    return '"projectId" must be a positive integer'
  }
  if (!files.photos) {
    return 'Must send `photos` field'
  }
}

function _validateEdit(...params) {
  // FIXME validate photo IDs to delete
  // FIXME validate obs field IDs to delete
}

async function validate(fields, files, uuid) {
  if (!files.observation) {
    return 'Must send an `observation` file containing JSON'
  }
  if (files.observation.mimetype !== 'application/json') {
    return '`observation` file must be `application/json`'
  }
  const observation  = await readJsonFile(files.observation.filepath)
  const obsUuid = observation.uuid
  if (obsUuid !== uuid) {
    return `UUID mismatch! "${uuid}" in URL path and "${obsUuid}" in body`
  }
  const photos = getPhotosFromFiles(files)
  if (!photos.every(e => e.mimetype.startsWith('image/'))) {
    return 'All `photos` files must have a `image/*` mime'
  }
  // FIXME should we validate further, so HEIC, etc images are disallowed?
  const validationError = (() => {
    const isUpdate = !!observation.id
    if (isUpdate) {
      return _validateEdit(fields, files)
    }
    return _validateCreate(fields, files)
  })()
  if (validationError) {
    return validationError
  }
  return {
    isSuccess: true,
    inatId: observation.id,
  }
}

async function getUuidsWithPendingStatus(req) {
  // FIXME add auth
  const pendingUuids = getDb()
    .prepare("SELECT uuid, status FROM uploads")
    .all()
  return {body: {
    pendingUuids,
  }}
}

function getPhotosFromFiles(files) {
  const photos = files.photos
  if (!photos) {
    return []
  }
  return photos.constructor === Array ? files.photos : [files.photos]
}

async function createInatObs({axios, apiBaseUrl}, {projectId}, files, authHeader) {
  // FIXME read stuff from DB, remove params
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
      `${apiBaseUrl}/v1/photos`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: authHeader,
        }
      }
    )
  }))
  // FIXME check for, and handle, auth failures from upstream
  // FIXME catch image post error, like an image/* that iNat doesn't like
  const photoIds = photoResps.map(e => e.data.id)
  log.debug(`Photo IDs from responses: ${photoIds}`)
  // FIXME handle ENOENT?
  const obsJson = await readJsonFile(files.observation.filepath)
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
  // FIXME check for, and handle, auth failures from upstream
  log.debug(`iNat response status for ${obsJson.uuid}: ${resp.status}`)
  return resp.data
}

async function updateInatObs({axios, apiBaseUrl}, fields, files, authHeader) {
  // FIXME read stuff from DB, remove params
  const obsJson = await readJsonFile(files.observation.filepath)
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
    // FIXME check for, and handle, auth failures from upstream
    return axios.post(
      `${apiBaseUrl}/v1/observation_photos`,
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
    // FIXME check for, and handle, auth failures from upstream
    return axios.delete(
      `${apiBaseUrl}/v1/observation_photos/${id}`,
      { headers: { Authorization: authHeader } }
    )
  }))
  const obsFieldIdsToDelete = JSON.parse(fields['obsFields-delete'])
  await Promise.all(obsFieldIdsToDelete.map(id => {
    log.debug(`Deleting obs field ${id}`)
    // FIXME check for, and handle, auth failures from upstream
    return axios.delete(
      `${apiBaseUrl}/v1/observation_field_values/${id}`,
      { headers: { Authorization: authHeader } }
    )
  }))
  log.debug(`Updating observation with ID=${inatRecordId}`)
  const resp = await axios.put(
    `${apiBaseUrl}/v1/observations/${inatRecordId}`,
    {
      // note: obs fields *not* included here are *not* implicitly deleted.
      observation: obsJson,
      ignore_photos: true,
    },
    { headers: { Authorization: authHeader } }
  )
  // FIXME check for, and handle, auth failures from upstream
  log.debug(`iNat response status for ${inatRecordId}: ${resp.status}`)
  return resp.data
}

function makeSemaphorePath(basePath) {
  return path.join(basePath, 'semaphore.txt')
}

function makeErrorLogPath(basePath) {
  return path.join(basePath, 'error.log')
}

function makeUpstreamBodyPath(basePath) {
  return path.join(basePath, 'new-obs.json')
}

async function readJsonFile(thePath) {
  const raw = await fsP.readFile(thePath)
  return JSON.parse(raw)
}

function makeUploadDirPath(uuid, seq) {
  return path.join(wowConfig().rootUploadDirPath, `${uuid}.${seq}`)
}

async function scheduleGcpTask(httpMethod, url) {
  // we don't bother killing existing tasks. We've marked the old DB records as
  // "superseded" so the callback will land and have no effect.
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
  await client.createTask({parent: parent, task: task})
  log.debug('Task scheduled')
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  // FIXME could check it looks like a JWT
  // FIXME check JWTs have "enough" time left before expiry to reduce chance of
  //   upstream failures
  if (!authHeader) {
    return res
      .status(401)
      .send({error: `Authorization header must be provided`})
  }
  try {
    log.debug(`Checking if supplied auth is valid: ${authHeader.substr(0,20)}...`)
    const resp = await realAxios.get(`${wowConfig().apiBaseUrl}/v1/users/me`, {
      headers: { Authorization: authHeader }
    })
    log.info('Auth from observations bundle is valid', resp.status)
    req.userDetail = resp.data?.results[0]
    return next()
  } catch (err) {
    log.info('Verifying auth passed in observations bundle has failed!', err.response.status)
    return res
      .status(401)
      .send({
        error: 'Authorization was rejected by upstream iNat server',
        upstreamError: err.response.data,
      })
  }
}

function isUuid(uuid) {
  // thanks https://ihateregex.io/expr/uuid/
  const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/
  return uuid.match(uuidRegex)
}

function initDb() {
  const db = getDb()
  try {
    db.prepare('SELECT 1 FROM uploads LIMIT 1').run()
    log.info(`DB and table exists, init not needed`)
  } catch (err) {
    if (!err.message.includes('no such table')) {
      log.warn('Error from DB check not as expected, dump here for humans to check', err)
    }
    log.warn('DB (probably) does not exist, creating it.')
    const t = db.transaction(() => {
      db.prepare(`
        CREATE TABLE uploads (
          uploadId INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT,
          inatId INT,
          projectId INT,
          user TEXT,
          obsJsonPath TEXT,
          apiToken TEXT,
          status TEXT,
          seq INT,
          updatedAt INT
          -- FIXME do we need user email column?
          -- FIXME do we need method column?
        )
      `).run()
      db.prepare(`
        CREATE TABLE photos (
          photoId INTEGER PRIMARY KEY AUTOINCREMENT,
          size INT,
          filepath TEXT,
          mimetype TEXT,
          uploadId INT,
          FOREIGN KEY(uploadId) REFERENCES uploads(uploadId)
        )
      `).run()
    })
    t()
  }
}

module.exports = {
  initDb,
  getUuidsWithPendingStatus: asyncHandler(getUuidsWithPendingStatus),
  obsHandler: asyncHandler(obsHandler),
  obsTaskStatusHandler: asyncHandler(_obsTaskStatusHandler),
  obsDeleteStatusHandler: asyncHandler(_obsDeleteStatusHandler),
  taskCallbackPostHandler: asyncHandler(_taskCallbackHandler, { // FIXME
    sendToUpstreamFnName: createInatObs.name,
  }),
  taskCallbackPutHandler: asyncHandler(_taskCallbackHandler, {
    sendToUpstreamFnName: updateInatObs.name,
  }),
  authMiddleware,
  _testonly: {
    _obsDeleteStatusHandler,
  },
}
