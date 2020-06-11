const Busboy = require('busboy')
const axios = require('axios')
const FormData = require('form-data')

const apiBaseUrl = (() => {
  const val = process.env.INAT_API_PREFIX
  if (!val) {
    throw new Error('Config error, INAT_API_PREFIX env var is not set')
  }
  return val.replace(/\/*$/, '')
})()
const isDev = process.env.IS_DEV_MODE === 'true'
const fieldNameObs = 'obs'
const fieldNameObsFields = 'obsFields'
const fieldNameProjectId = 'projectId'
console.info(`WOW facade for iNat API
  Target API: ${apiBaseUrl}
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
    } else if (req.method !== 'POST') {
      // Return a "method not allowed" error
      return res.status(405).end()
    }
    const authHeader = req.header('Authorization')
    if (!authHeader) {
      return json(res, { msg: 'Missing Authorization header' }, 403)
    }
    const { fields, files } = parseReq(req)
    console.debug(
      'Summary of files',
      files.map(f => ({
        ...f,
        data: `${f.data.readableLength} bytes`,
      })),
    )

    // FIXME handle photoIdsToDelete?

    const coreObs = fields[fieldNameObs]
    if (!coreObs) {
      // TODO could also verify schema of record
      return json(
        res,
        { msg: `field 'obs' (the core observation) must be supplied` },
        400,
      )
    }

    const projectIdRaw = fields[fieldNameProjectId]
    if (!projectIdRaw) {
      return json(
        res,
        { msg: `field 'projectId' must be supplied (it's a number)` },
        400,
      )
    }
    if (isNaN(projectIdRaw)) {
      return json(
        res,
        {
          msg: `field 'projectId' was '${JSON.stringify(
            projectIdRaw,
          )}' but must be a number`,
        },
        400,
      )
    }
    const projectId = parseInt(projectIdRaw)

    const obsFields = fields[fieldNameObsFields]
    if (!obsFields) {
      return json(
        res,
        { msg: `field 'obsFields' (array of obs fields) must be supplied` },
        400,
      )
    }
    if (obsFields.constructor !== Array || obsFields.length < 1) {
      // TODO could check schema of objects
      const len = obsFields.length || 0
      return json(
        res,
        {
          msg:
            `field 'obsFields' was '${obsFields.constructor.name}' with ` +
            `length=${len} but must be an Array with at least one item`,
        },
        400,
      )
    }

    const obsInatId = await createCoreObs(coreObs, authHeader)
    console.debug(`Core obs created with inatId=${obsInatId}`)
    const [elapsedWithoutPhotos] = await Promise.all([
      (async function() {
        await createAllObsFieldsAndLinkProject(
          obsInatId,
          obsFields,
          projectId,
          authHeader,
        )
        const elapsedWithoutPhotos = Date.now() - startMs
        return elapsedWithoutPhotos
      })(),
      createAllPhotos(obsInatId, files, authHeader),
    ])

    const elapsed = Date.now() - startMs

    return json(res, {
      elapsedTotalMs: elapsed,
      elapsedWithoutPhotosMs: elapsedWithoutPhotos,
      obsFieldCount: obsFields.length,
      photoCount: files.length,
      obsSummary: {
        uuid: coreObs.uuid,
        inatId: obsInatId,
      },
    })
  } catch (err) {
    console.error('Internal server error', err)
    const body = { msg: 'Internal server error' }
    if (isDev) {
      body.detail = err.message
    }
    return json(res, body, 500)
  }
}

function parseReq(req) {
  const busboy = new Busboy({ headers: req.headers })
  const fields = {}
  const files = []

  busboy.on('field', (fieldname, val) => {
    console.debug(`Processed field ${fieldname}: ${val}.`)
    fields[fieldname] = (() => {
      try {
        return JSON.parse(val)
      } catch (err) {
        console.warn(`Failed to parse JSON for fieldname=${fieldname}`)
        return val
      }
    })()
  })

  busboy.on('file', (fieldname, file, filename) => {
    console.debug(`Processed file ${filename}`)
    files.push({
      uploadedAsFieldname: fieldname,
      filename,
      data: file, // a ReadableStream
    })
  })

  busboy.end(req.rawBody)
  return { fields, files }
}

async function createCoreObs(obsRecord, authHeader) {
  try {
    console.debug('Creating core obs: ' + JSON.stringify(obsRecord, null, 2))
    const resp = await doPost('observations', obsRecord, authHeader)
    return Promise.resolve(resp.data.id)
  } catch (err) {
    throw chainedError('Failed to create core obs', err)
  }
}

async function createAllObsFieldsAndLinkProject(
  obsInatId,
  obsFields,
  projectId,
  authHeader,
) {
  console.debug(`Creating ${obsFields.length} obs fields and linking project`)
  // FIXME should probably send in small batches, perhaps 5
  await Promise.all(
    obsFields.map(f => {
      return doPost(
        'observation_field_values',
        {
          ...f,
          observation_id: obsInatId,
        },
        authHeader,
      )
    }),
  )
  return doPost(
    'project_observations',
    {
      observation_id: obsInatId,
      project_id: projectId,
    },
    authHeader,
  )
}

async function createAllPhotos(obsInatId, files, authHeader) {
  return Promise.all(
    files.map(f => {
      const fd = new FormData()
      fd.append('observation_photo[observation_id]', obsInatId)
      fd.append('file', f.data, {
        filename: f.filename,
        // TODO do we get sent mime? Otherwise magic number it
        // contentType: 'image/jpeg',
      })
      const extraHeaders = fd.getHeaders()
      return doPost('observation_photos', fd, authHeader, extraHeaders)
    }),
  )
}

async function doPost(urlSuffix, body, authHeader, extraHeaders = {}) {
  const url = `${apiBaseUrl}/${urlSuffix}`
  const bodyDebugLimit = 100
  const bodyDebug = (() => {
    if (body.constructor === FormData) {
      // we can't interrogate it because it's really a stream
      return `(FormData)`
    }
    return JSON.stringify(body).substring(0, bodyDebugLimit)
  })()
  try {
    const result = await axios.post(url, body, {
      headers: {
        Authorization: authHeader,
        ...extraHeaders,
      },
    })
    console.debug(
      `HTTP POST ${url}\n` +
        `  body (max ${bodyDebugLimit} chars): ${bodyDebug}\n` +
        `  SUCCESS ${result.status}`,
    )
    return result
  } catch (err) {
    const respBody = (() => {
      const val = err.response.data
      if (typeof val === 'object') {
        return JSON.stringify(val)
      }
      return val
    })()
    const msg =
      `HTTP POST ${url}\n` +
      `  Req body (${bodyDebugLimit} chars): ${bodyDebug}\n` +
      `  FAILED ${err.response.status} (${err.response.statusText})\n` +
      `  Resp body: ${respBody}`
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

function chainedError(msg, err) {
  // FIXME add proper error chaining
  const newMsg = `${msg}\nCaused by: ${err.message}`
  err.message = newMsg
  return err
}
