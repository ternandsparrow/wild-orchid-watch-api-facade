function stripTrailingSlashes(url) {
  const stripTrailingSlashesRegex = /\/*$/
  return (url || '').replace(stripTrailingSlashesRegex, '')
}

function getUrlEnvVar(name) {
  const val = process.env[name]
  return stripTrailingSlashes(val)
}

module.exports = {
  getUrlEnvVar,
  stripTrailingSlashes,
}
