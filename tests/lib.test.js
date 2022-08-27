const objectUnderTest = require('../src/lib.js')

describe('stripTrailingSlashes', () => {
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
})

describe('getExpiryFromJwt', () => {
  test('removes multiple trailing slashes from a URL', () => {
    const jwt = 'eyJhbGciOiJIUzUxMiJ9.' +
      'eyJ1c2VyX2lkIjoxLCJvYXV0aF9hcHBsaWNhdGlvbl9pZCI6MSwiZXhwIjoxNjYxNzAzMTg2fQ.' +
      'nz7d5MWZGqlxN4dkoNen4-0It290tTAQ3x4xVTFtt3uhQhjB1hlXc-Ea7VL8LrhWRd9WAtdmF8aJXHdzVwr8UQ'
    const result = objectUnderTest.getExpiryFromJwt(jwt)
    expect(result).toBe(1661703186)
  })
})
