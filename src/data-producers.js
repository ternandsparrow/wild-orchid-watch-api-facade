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
  Sentry,
  getExpiryFromJwt,
  log,
  taskCallbackUrlPrefix,
  taskStatusUrlPrefix,
  wowConfig,
} = require('./lib.js')
const oneHundredMb = 100 * 1000 * 1000

const dbPath = process.env.DB_PATH || path.join(wowConfig().rootUploadDirPath, 'data.db')

const getDb = (() => {
  let instance = null
  return function() {
    if (!instance) {
      log.debug('Creating new sqlite client')
      instance = betterSqlite3(dbPath)
      process.on('exit', () => {
        log.debug('Closing sqlite connection')
        instance.close()
      })
    }
    return instance
  }
})()

async function _obsTaskStatusHandler(req) {
  const {uuid} = req.params
  if (!isUuid(uuid)) {
    return {
      status: 400,
      body: {error: `uuid path param is NOT valid`},
    }
  }
  const {seq, status} = getLatestUploadRecord(uuid)
  if (!status) {
    return {
      status: 404,
      body: {error: `${uuid} doesn't exit`},
    }
  }
  const uploadDirPath = makeUploadDirPath(uuid, seq)
  const upstreamRespBodyPath = makeUpstreamBodyPath(uploadDirPath)
  const upstreamBody = await (async () => {
    if (!(await isPathExists(upstreamRespBodyPath))) {
      return
    }
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

async function obsDeleteHandler(req, { isLocalDev }) {
  const {uuid, inatId} = req.params
  const db = getDb()
  const t = db.transaction(() => {
    markSuperseded(db, uuid)
    db.prepare(`
      INSERT INTO uploads (
        uuid, inatId, user, apiToken, status, updatedAt
      ) VALUES (?, ?, ?, ?, 'pending', datetime())
    `)
    .run(
      uuid,
      inatId,
      req.userDetail.login,
      req.headers['authorization'],
    )
  })
  t()
  const callbackMethod = 'DELETE'
  const {callbackUrl, statusUrl} = getTheUrls(req, isLocalDev, uuid)
  log.debug(`Callback URL will be: ${callbackMethod} ${callbackUrl}`)
  log.debug(`Status URL will be: GET ${statusUrl}`)
  await scheduleGcpTask(callbackMethod, callbackUrl)
  return {body: {
    uuid,
    statusUrl,
    queuedTaskDetails: {
      callbackMethod,
      callbackUrl,
    },
  }}
}

function isCallbackAuthValid(req) {
  const secret = wowConfig().callbackSecret
  if (!secret) {
    return true
  }
  const authHeader = req.headers['authorization']
  return authHeader === secret
}

async function obsUpsertHandler(req, { isLocalDev }) {
  const {uuid} = req.params
  if (!isUuid(uuid)) {
    return {
      status: 400,
      body: {error: `uuid path param is NOT valid`},
    }
  }
  log.info(`Handling obs ${uuid}`)
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
      if (!files.photos) {
        files.photos = []
      }
      if (files.photos.constructor !== Array) {
        log.debug('Single photo sent, converting to array')
        files.photos = [files.photos]
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
    markSuperseded(db, uuid)
    log.debug(`Creating upload record for ${uuid}`)
    const uploadId = insertUploadRecord(
      uuid,
      validationResp.inatId,
      fields.projectId,
      userDetail.login,
      files.observation.filepath,
      req.headers['authorization'],
      seq,
      fields['photos-delete'] || '[]',
      fields['obsFields-delete'] || '[]',
    )
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
  const callbackMethod = 'POST'
  const {callbackUrl, statusUrl} = getTheUrls(req, isLocalDev, uuid)
  log.debug(`Callback URL will be: ${callbackMethod} ${callbackUrl}`)
  log.debug(`Status URL will be: GET ${statusUrl}`)
  await scheduleGcpTask(callbackMethod, callbackUrl)
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

async function taskCallbackDeleteHandler(uuid, { axios, apiBaseUrl }) {
  const { uploadId, inatId, apiToken, status } = getLatestUploadRecord(uuid)
  if (status !== 'pending') {
    return {body: {
      isSuccess: true,
      wasProcessed: false,
    }}
  }
  try {
    if (inatId) {
      // a "create" followed immediately by a "delete" won't have an inatId
      // because it hasn't landed on inatId yet.
      await axios.delete(`${apiBaseUrl}/v1/observations/${inatId}`, {
        headers: { Authorization: apiToken }
      })
    } else {
      log.debug(`No inatId for upload=${uploadId}, no need to talk to iNat`)
    }
    setTerminalRecordStatus(uploadId, 'success')
    return {body: {
      isSuccess: true,
      wasProcessed: true,
    }}
  } catch (err) {
    const upstreamStatus = err.response?.status
    if (upstreamStatus === 404) {
      log.warn(`obs ${inatId} did not exist on iNat, nothing to do`)
      setTerminalRecordStatus(uploadId, 'success')
      return {body: {
        isSuccess: true,
        wasProcessed: false,
      }}
    }
    const uploadDirPath = makeUploadDirPath(uuid, `delete.${Date.now()}`)
    return handleUpstreamError(err, uploadId, uploadDirPath)
  }
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
      const theFn = dispatchables[fnName]
      if (!theFn) {
        throw new Error(`Could not dispatch "${fnName}" function`)
      }
      return theFn(wowContext, ...args)
    }
    const firstParam = req.uuid || req
    const transaction = Sentry.startTransaction({
      op: workerFn.name,
    })
    workerFn(firstParam, wowContext)
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
        log.error(`Error while running function ${workerFn.name}`, err)
        Sentry.captureException(err)
        res.status(500).send({error: 'The server exploded :('})
      })
      .finally(() => {
        transaction.finish()
      })
  }
}

function getLatestUploadRecord(uuid) {
  const db = getDb()
  const result = db.prepare(`
    SELECT *
    FROM uploads
    WHERE uuid = @uuid
    ORDER BY rowId DESC
    LIMIT 1
  `).get({uuid})
  if (result && !result.inatId) {
    // look up inatId not known at task creation time, but *is* known now
    const resultSet = db.prepare(`
      SELECT inatId
      FROM uploads
      WHERE uuid = @uuid
      AND inatId IS NOT NULL
      LIMIT 1
    `).get({uuid})
    if (resultSet?.inatId) {
      log.debug(`Found inatId=${resultSet.inatId} using lookback for uuid=${uuid}`)
      result.inatId = resultSet.inatId
    }
  }
  return result || {}
}

// according to https://cloud.google.com/tasks/docs/tutorial-gcf
// > Any status code other than 2xx or 503 will trigger the task to retry
async function taskCallbackPostHandler(uuid, { dispatch }) {
  log.info(`Processing task callback for ${uuid}`)
  const uploadRecord = getLatestUploadRecord(uuid)
  const { uploadId, status, seq, inatId } = uploadRecord
  if (!status) {
    return {status: 404, body: {msg: `${uuid} not found`}}
  }
  const isNotAnUpdateRecord = !seq
  if (isNotAnUpdateRecord) {
    return {status: 400, body: {msg: `${uuid} is not an update record`}}
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
    const upstreamRespBody = await dispatch(sendToUpstreamFnName, uploadRecord)
    const upstreamRespBodyPath = makeUpstreamBodyPath(uploadDirPath)
    log.debug(`Writing upstream resp body to file: ${upstreamRespBodyPath}`)
    await fsP.writeFile(upstreamRespBodyPath, JSON.stringify(upstreamRespBody))
    log.debug(`Upstream resp body written, cleaning up for ${uuid}`)
    setTerminalRecordStatus(uploadId, 'success', upstreamRespBody.id)
    log.info(`Successfully processed ${uuid}; ID=${upstreamRespBody.id}`)
    return {body: {
      isSuccess: true,
      wasProcessed: true,
    }}
  } catch (err) {
    return handleUpstreamError(err, uploadId, uploadDirPath)
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

function _validateEdit() {
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
  const observation = await readJsonFile(files.observation.filepath)
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
    const isUpdate = isUploadExistsForUuid(obsUuid) || !!observation.id
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

function isUploadExistsForUuid(theUuid) {
  const db = getDb()
  const queryResult = db.prepare(`
    SELECT 1
    FROM uploads
    WHERE uuid = @uuid
    LIMIT 1
  `).get({uuid: theUuid})
  return !!queryResult
}

function getUuidsWithPendingStatus(req) {
  const {all} = req.query
  const limitClause = (() => {
    if (all === 'true') {
      return ''
    }
    return 'LIMIT 100'
  })()
  const pendingUuids = getDb()
    .prepare(`
      SELECT uuid, status, updatedAt, seq
      FROM uploads
      WHERE status = 'pending'
      ORDER BY updatedAt DESC
      ${limitClause}
    `).all().map(r => ({
      uuid: r.uuid,
      status: r.status,
      updatedAtUTC: r.updatedAt,
      type: r.seq ? 'update' : 'delete',
    }))
  // asyncHandler wrapped functions must return promises
  return Promise.resolve({body: {
    pendingUuids,
  }})
}

function getPhotosForUploadId(uploadId) {
  return getDb().prepare(`
    SELECT *
    FROM photos
    WHERE uploadId = ?
  `).all(uploadId)
}

function getPhotosFromFiles(files) {
  const photos = files.photos
  if (!photos) {
    return []
  }
  return photos.constructor === Array ? files.photos : [files.photos]
}

async function createInatObs({axios, apiBaseUrl}, uploadRecord) {
  const {uuid, uploadId, projectId, apiToken, obsJsonPath} = uploadRecord
  const photos = getPhotosForUploadId(uploadId)
  log.debug(`Uploading ${photos.length} photos`)
  const photoResps = await Promise.all(photos.map(p => {
    const form = new FormData()
    const fileStream = fs.createReadStream(p.filepath)
    log.debug(`Appending photo that is ${p.size / 1000}kb`)
    form.append('file', fileStream, {
      contentType: p.mimetype,
      knownLength: p.size,
    })
    return axios({
        method: 'post',
        url: `${apiBaseUrl}/v1/photos`,
        data: form,
        headers: {
          ...form.getHeaders(),
          Authorization: apiToken,
        },
        maxContentLength: oneHundredMb,
        maxBodyLength: oneHundredMb,
    })
  }))
  // FIXME catch image post error, like an image/* that iNat doesn't like
  const photoIds = photoResps.map(e => e.data.id)
  log.debug(`Photo IDs from responses: ${photoIds}`)
  // FIXME handle ENOENT?
  const obsJson = await readJsonFile(obsJsonPath)
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
    headers: { Authorization: apiToken }
  })
  log.debug(`iNat response status for POST ${uuid}: ${resp.status}`)
  return resp.data
}

async function updateInatObs({axios, apiBaseUrl}, uploadRecord) {
  const {uploadId, inatId, apiToken, obsJsonPath} = uploadRecord
  if (!inatId) {
    throw new Error(`Could not find inat ID`)
  }
  const photos = getPhotosForUploadId(uploadId)
  log.debug(`Processing ${photos.length} photos for upload ${uploadId}`)
  await Promise.all(photos.map(p => {
    const form = new FormData()
    const fileStream = fs.createReadStream(p.filepath)
    form.append('observation_photo[observation_id]', inatId)
    log.debug(`Appending photo as part of obs update that is ${p.size / 1000}kb`)
    form.append('file', fileStream, {
      contentType: p.mimetype,
      knownLength: p.size,
    })
    return axios({
        method: 'post',
        url: `${apiBaseUrl}/v1/observation_photos`,
        data: form,
        headers: {
          ...form.getHeaders(),
          Authorization: apiToken,
        },
        maxContentLength: oneHundredMb,
        maxBodyLength: oneHundredMb,
    })
  }))
  const photoIdsToDelete = JSON.parse(uploadRecord.photoIdsToDelete)
  log.debug(`Deleting ${photoIdsToDelete.length} photos for upload ${uploadId}`)
  await Promise.all(photoIdsToDelete.map(id => {
    log.debug(`Deleting photo ${id}`)
    return axios.delete(
      `${apiBaseUrl}/v1/observation_photos/${id}`,
      { headers: { Authorization: apiToken } }
    )
  }))
  const obsFieldIdsToDelete = JSON.parse(uploadRecord.obsFieldIdsToDelete)
  log.debug(`Deleting ${obsFieldIdsToDelete.length} obs fields for upload ${uploadId}`)
  await Promise.all(obsFieldIdsToDelete.map(id => {
    log.debug(`Deleting obs field ${id}`)
    return axios.delete(
      `${apiBaseUrl}/v1/observation_field_values/${id}`,
      { headers: { Authorization: apiToken } }
    )
  }))
  log.debug(`Updating observation with ID=${inatId}`)
  const obsJson = await readJsonFile(obsJsonPath)
  const resp = await axios.put(
    `${apiBaseUrl}/v1/observations/${inatId}`,
    {
      // note: obs fields *not* included here are *not* implicitly deleted.
      observation: obsJson,
      ignore_photos: true,
    },
    { headers: { Authorization: apiToken } }
  )
  log.debug(`iNat response status for PUT ${inatId}: ${resp.status}`)
  return resp.data
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
      headers: {
        'Authorization': wowConfig().callbackSecret,
      },
    },
  }
  log.debug(`Scheduling callback task for ${httpMethod} ${url}`)
  await client.createTask({parent: parent, task: task})
  log.debug(`Task scheduled for ${httpMethod} ${url}`)
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader) {
    return res
      .status(401)
      .send({error: `Authorization header must be provided`})
  }
  if (req.method !== 'GET') {
    try {
      const exp = getExpiryFromJwt(authHeader)
      const isExpiringWithinFiveMins = (Date.now() / 1000) + (5 * 60) > exp
      if (isExpiringWithinFiveMins) {
        return res.status(401).send({error: 'Token is expiring too soon'})
      }
    } catch (err) {
      log.error('Failed while checking JWT exp', err)
      return res.status(500).send({error: 'The server exploded'})
    }
  }
  const authTokenStart = authHeader.substr(0,20)
  try {
    log.trace(`Checking if supplied auth is valid: ${authTokenStart}...`)
    const resp = await realAxios.get(`${wowConfig().apiBaseUrl}/v1/users/me`, {
      headers: { Authorization: authHeader }
    })
    log.info('Auth from observations bundle is valid', resp.status)
    req.userDetail = resp.data?.results[0]
    return next()
  } catch (err) {
    log.info(
      `Verifying auth ${authTokenStart}... passed in observations bundle has failed!`,
      err.response.status)
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

function getTheUrls(req, isLocalDev, uuid) {
  const serverUrlPrefix = (()=> {
    const protocol = isLocalDev ? req.protocol : 'https'
    return `${protocol}://${req.headers.host}`
  })()
  const callbackUrl = `${serverUrlPrefix}${taskCallbackUrlPrefix}/${uuid}`
  const statusUrl = `${serverUrlPrefix}${taskStatusUrlPrefix}/${uuid}`
  return {callbackUrl, statusUrl}
}

function markSuperseded(db, uuid) {
  const {changes} = db.prepare(`
    UPDATE uploads
    SET
      apiToken = NULL,
      status = 'superseded',
      updatedAt = datetime()
    WHERE uuid = ?
    AND status = 'pending'
  `).run(uuid)
  log.debug(`Marked ${changes} old ${uuid} records as superseded`)
}

function setTerminalRecordStatus(uploadId, status, inatId) {
  const inatIdFragment = (() => {
    if (!inatId) {
      return ''
    }
    log.debug(`Updating inatId=${inatId} for upload=${uploadId}`)
    return `inatId = @inatId,`
  })()
  getDb().prepare(`
    UPDATE uploads
    SET
      apiToken = NULL,
      status = @status,
      ${inatIdFragment}
      updatedAt = datetime()
    WHERE uploadId = @uploadId
  `).run({uploadId, status, inatId})
}

function insertUploadRecord(...params) {
  const db = getDb()
  const {lastInsertRowid} = db.prepare(`
    INSERT INTO uploads (
      uuid, inatId, projectId, user, obsJsonPath, apiToken, status, seq,
      updatedAt, photoIdsToDelete, obsFieldIdsToDelete
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 'pending', ?, datetime(), ?, ?
    )
  `)
  .run(...params)
  const {uploadId} = db
    .prepare('SELECT uploadId FROM uploads WHERE rowid = ?')
    .get(lastInsertRowid)
  return uploadId
}

async function handleUpstreamError(err, uploadId, uploadDirPath) {
  const upstreamStatus = err.response?.status
  const errorLogPath = makeErrorLogPath(uploadDirPath)
  const errDump = err.stack || err.msg
  await fsP.appendFile(
    errorLogPath,
    `[${new Date().toISOString()}] Status=${upstreamStatus}; err=${errDump}\n`,
  )
  if (upstreamStatus) {
    log.error(
      `Request to iNat failed with status=${upstreamStatus}.`,
      err.response.data,
    )
  } else {
    log.error('Request to iNat failed', err)
  }
  const isTerminalFailure = upstreamStatus === 401
  if (isTerminalFailure) {
    setTerminalRecordStatus(uploadId, 'failure')
    const status = 200 // not success as such, but the task cannot be retried
    const noRetryMsg = 'Above error was terminal, task will not be retried\n'
    await fsP.appendFile(errorLogPath, noRetryMsg)
    log.warn(noRetryMsg)
    return {status, body: {isSuccess: false, canRetry: false}}
  }
  const status = 500 // will cause GCP Tasks to retry
  // GCP doesn't care about the body, but as a dev calling the endpoint, it's
  // useful to know what happened
  return {status, body: {isSuccess: false, canRetry: true}}
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
          updatedAt INT,
          photoIdsToDelete TEXT,
          obsFieldIdsToDelete TEXT
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
  obsUpsertHandler: asyncHandler(obsUpsertHandler),
  obsDeleteHandler: asyncHandler(obsDeleteHandler),
  obsTaskStatusHandler: asyncHandler(_obsTaskStatusHandler),
  taskCallbackPostHandler: asyncHandler(taskCallbackPostHandler),
  taskCallbackDeleteHandler: asyncHandler(taskCallbackDeleteHandler),
  authMiddleware,
  _testonly: {
    getDb,
    insertUploadRecord,
    setTerminalRecordStatus,
  },
  taskCallbackMiddleware: (req, res, next) => {
    if (!isCallbackAuthValid(req)) {
      return res
        .status(403)
        .send(JSON.stringify({msg: 'auth invalid'}))
    }
    const {uuid} = req.params
    if (!isUuid(uuid)) {
      return res
        .status(400)
        .send(JSON.stringify({error: `uuid path param is NOT valid`}))
    }
    req.uuid = uuid
    return next()
  }
}
