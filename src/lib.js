const fs = require('fs')
require('dotenv').config()
const Sentry = require('@sentry/node')

const noop = function() {}
const logLevel = process.env.LOG_LEVEL || 'INFO'
const log = {
  trace: logLevel === 'TRACE' ? makeLogger('TRACE', 'log') : noop,
  debug: ['TRACE', 'DEBUG'].includes(logLevel) ? makeLogger('DEBUG', 'log') : noop,
  info: makeLogger('INFO', 'info'),
  warn: makeLogger('WARN', 'warn'),
  error: makeLogger('ERROR', 'error'),
}

let cachedConfig = null

function wowConfig() {
  if (cachedConfig) {
    return cachedConfig
  }
  const localDevEnvName = 'local-dev'
  const result = {
    inatBaseUrl:
    getUrlEnvVar('INAT_PREFIX') || 'https://dev.inat.techotom.com',
    apiBaseUrl:
    getUrlEnvVar('INAT_API_PREFIX') || 'https://dev.api.inat.techotom.com',
    gitSha: process.env.GIT_SHA || '(nothing)',
    rootUploadDirPath: process.env.UPLOAD_DIR_PATH || './uploads',
    // the WOW project identifier. Slug is the fragment of URL, e.g.
    //  wow_project, not the numeric ID
    inatProjectSlug:
    process.env.INAT_PROJECT_SLUG || 'wow-dev2',
    oauthAppId: process.env.OAUTH_APP_ID ||
    '1c0c5c9b05f181b7b59411b311c84cf4c134158e890a348cfa967e905b579c28',
    oauthAppSecret: getRequiredEnvVar('OAUTH_APP_SECRET'),
    // these login details must be for a user that is a curator/manager of the
    //  iNat project as this role allows us to get unobscured GPS coordinates
    //  for observations. This should be a dedicated user just for this use.
    oauthUsername: getRequiredEnvVar('OAUTH_USERNAME'),
    oauthPassword: getRequiredEnvVar('OAUTH_PASSWORD'),
    deployedEnvName: process.env.DEPLOYED_ENV_NAME || localDevEnvName,
    sentryDsn: process.env.SENTRY_DSN,
    gcpRegion: process.env.GCP_REGION || 'us-west1',
    gcpProject: process.env.GCP_PROJECT,
    gcpQueue: process.env.GCP_QUEUE,
  }
  result.isLocalDev = result.deployedEnvName === localDevEnvName

  if (!result.isLocalDev) {
    const requiredProdConfig = ['gcpProject', 'gcpQueue']
    for (const curr of requiredProdConfig) {
      if (!result[curr]) {
        throw new Error(`Config ${curr} is not supplied but required in prod mode!`)
      }
    }
  }

  // these are keys we issue for clients to call us. We support multiple keys so
  //  each caller has their own one. This makes rotating keys easier and we can
  //  compute some metrics on who is calling. The keys can be any string, they're
  //  just opaque tokens. We have a check to make sure they're sufficiently long
  //  that brute forcing isn't realistic.
  result.allApiKeys = [
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

  if (result.sentryDsn) {
    Sentry.init({
      dsn: result.sentryDsn,
      tracesSampleRate: 1.0,
      release: result.gitSha,
      environment: result.deployedEnvName,
    })
  } else {
    if (!result.isLocalDev) {
      throw new Error('Sentry must be configured for deployed envs, it currently is not')
    }
    log.warn('[WARN] No Sentry DSN provided, refusing to init Sentry client')
  }

  ;(() => { // eslint-disable-line no-extra-semi
    try {
      log.debug(`Asserting upload dir (${result.rootUploadDirPath}) exists`)
      const d = fs.opendirSync(result.rootUploadDirPath)
      d.close()
      log.debug(`Upload dir DOES exist`)
    } catch (err) {
      if (err.code === 'ENOENT') {
        log.warn('Upload dir does NOT exist, attemping to create...')
        fs.mkdirSync(result.rootUploadDirPath)
        log.warn('Upload dir successfully created')
        return
      }
      if (err.code === 'ENOTDIR') {
        throw new Error(`Upload dir path ${result.rootUploadDirPath} exists` +
          ', but is NOT a directory, cannot continue')
      }
      throw err
    }
  })()
  cachedConfig = result
  return result
}

function makeLogger(levelTag, fnOnConsole) {
  return function(...args) {
    console[fnOnConsole](new Date().toISOString(), `[${levelTag}]`, ...args)
  }
}

function stripTrailingSlashes(url) {
  const stripTrailingSlashesRegex = /\/*$/
  return (url || '').replace(stripTrailingSlashesRegex, '')
}

function getUrlEnvVar(name) {
  const val = process.env[name]
  return stripTrailingSlashes(val)
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

module.exports = {
  Sentry,
  getUrlEnvVar,
  json,
  log,
  stripTrailingSlashes,
  taskCallbackUrlPrefix: '/task-callback',
  wowConfig,
}
