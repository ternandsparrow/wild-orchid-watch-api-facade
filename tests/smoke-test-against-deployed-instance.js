// runs a "smoke test" against a deployed facade instance.
const axios = require('axios')

const targetHost = process.argv[2]
if (!targetHost) {
  console.error('First param must be host to smoke test, e.g: https://dev-api-facade.wildorchidwatch.org')
  process.exit(1)
}

console.log(`Testing against ${targetHost}`)


const orderedTests = [
  async function versionEndpoint() {
    const resp = await axios.get(`${targetHost}/version`) 
    if (!resp.data.gitSha) {
      throw new Error('Version endpoint response missing gitSha field')
    }
  },
  async function taskStatusesEndpoint() {
    const resp = await axios.get(`${targetHost}/ops/task-statuses`) 
    if (resp.data.pendingUuids.constructor !== Array) {
      throw new Error('Expected task status list endpoint to return an array')
    }
  },
]

async function main() {
  const startMs = Date.now()
  for (let curr of orderedTests) {
    console.log(`Running "${curr.name}"`)
    try {
      await curr()
    } catch (err) {
      console.error(`  ${curr.name} fail`)
      console.error(err)
      break
    }
  }
  console.log(`All smoke tests finished in ${Date.now() - startMs}ms`)
}

main().catch(err => {
  console.error('Failed', err)
  process.exit(1)
})
