// code related to servicing our data consumers: trusted third parties who need
// access to observation data
const axios = require('axios')
const {json, log, Sentry, wowConfig} = require('./lib.js')

let outboundAuth = null

module.exports.dataConsumerObservationsHandler = async function(req, res) {
  const transaction = Sentry.startTransaction({
    op: '/wow-observations',
    name: 'The obs handler function',
  })
  try {
    const startMs = Date.now()
    const apiKey = req.headers.authorization
    const isAuthorised = wowConfig.allApiKeys.includes(apiKey)
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
    if (wowConfig.isDev) {
      body.devDetail = err.message
    }
    return json(res, body, 500)
  } finally {
    transaction.finish()
  }
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
      client_id: wowConfig.oauthAppId,
      client_secret: wowConfig.oauthAppSecret,
      grant_type: 'password',
      username: wowConfig.oauthUsername,
      password: wowConfig.oauthPassword,
    }
    const url = `${wowConfig.inatBaseUrl}/oauth/token`
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
    const url = `${wowConfig.inatBaseUrl}/users/api_token`
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
  const url = `${wowConfig.apiBaseUrl}/v1/observations`
  const params = {
    ...inboundQuerystring,
    project_id: wowConfig.inatProjectSlug,
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
    if (err.isAxiosError && wowConfig.isDev) {
      throw new Error(`Axios error: ${msg}`)
    }
    log.error(msg)
    throw err
  }
}

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
