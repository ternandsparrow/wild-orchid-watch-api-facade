const {initDb, _testonly: objectUnderTest} = require('../src/data-producers.js')

describe('setTerminalRecordStatus', () => {
  beforeAll(() => {
    // FIXME silence logging
    initDb()
  })

  test('handles "success" status', async () => {
    objectUnderTest.insertUploadRecord(
      '123A', // uuid
      11,     // inatId,
      null,   // projectId
      'user', // user
      '/some/path.json',
      'ey...',// auth
      456,    // seq
      [],     // photo IDs to delete
      [],     // obs field IDs to delete
    )
    objectUnderTest.setTerminalRecordStatus('123A', 'success')
    const result = objectUnderTest.getDb().prepare('SELECT * FROM uploads WHERE uuid = ?').get('123A')
    expect(result.status).toBe('success')
    expect(result.apiToken).toBe(null)
  })
})
