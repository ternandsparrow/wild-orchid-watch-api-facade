function stripTrailingSlashes(url) {
  const stripTrailingSlashesRegex = /\/*$/
  return url.replace(stripTrailingSlashesRegex, '')
}

module.exports = {
  stripTrailingSlashes,
}
