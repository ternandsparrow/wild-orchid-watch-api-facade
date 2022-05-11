const {fail} = require('jest')
const objectUnderTest = require('../src/data-producers.js')._testonly

describe('_obsDeleteStatusHandler', () => {
  test('handles "success" situation', async () => {
    const req = {params: {inatId: '123'}}
    const axios = {get: async () => ({data: {total_results: 0}})}
    const result = await objectUnderTest._obsDeleteStatusHandler(req, {axios, apiBaseUrl: 'z'})
    expect(result.body.taskStatus).toBe('success')
  })

  test('handles "processing" situation', async () => {
    const req = {params: {inatId: '123'}}
    const axios = {get: async () => ({data: {total_results: 1}})}
    const result = await objectUnderTest._obsDeleteStatusHandler(req, {axios, apiBaseUrl: 'z'})
    expect(result.body.taskStatus).toBe('processing')
  })

  test('handles "failure" situation', async () => {
    const req = {params: {inatId: '123'}}
    const axios = {get: async () => {throw new Error('bang')}}
    try {
      await objectUnderTest._obsDeleteStatusHandler(req, {axios, apiBaseUrl: 'z'})
      fail()
    } catch (err) {
      expect(err.message).toBe('bang')
    }
  })
})
