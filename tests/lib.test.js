const objectUnderTest = require('../src/lib.js')

test('leaves a URL without a trailing slash as-is', () => {
  const url = 'http://inaturalist.org'
  const result = objectUnderTest.stripTrailingSlashes(url)
  expect(result).toBe(url)
})

test('removes a trailing slash from a URL', () => {
  const base = 'http://inaturalist.org'
  const withSlash = `${base}/`
  const result = objectUnderTest.stripTrailingSlashes(withSlash)
  expect(result).toBe(base)
})

test('removes multiple trailing slashes from a URL', () => {
  const base = 'http://inaturalist.org'
  const withSlash = `${base}////`
  const result = objectUnderTest.stripTrailingSlashes(withSlash)
  expect(result).toBe(base)
})
