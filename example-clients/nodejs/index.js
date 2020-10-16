const axios = require('axios')

const clientApiKey = (() => {
  const result = process.env.API_KEY
  if (result) {
    return result
  }
  throw new Error('Env var API_KEY must be supplied')
})()

async function main() {
  const pageSize = 3
  let page = 1
  const url =
    'https://api-facade.wildorchidwatch.org/wow-observations' +
    `?per_page=${pageSize}`
  const maxPages = 3
  let isMorePages = true
  while (isMorePages) {
    const urlWithPage = `${url}&page=${page}`
    console.info(`Processing page ${page}`)
    const resp = await axios.get(urlWithPage, {
      headers: {
        Authorization: clientApiKey,
      },
    })
    if (resp.status !== 200) {
      throw new Error(
        `Failed to make HTTP call for page=${page}, status=${resp.status}`,
      )
    }
    const body = resp.data
    const totalResults = body.total_results
    for (const curr of body.results) {
      console.info(`ID=${curr.id}`)
      // all observations submitted via the app will be obscured but users are
      // free to add observations using other clients and these may not be
      // obscured.
      const loc = curr.obscured
        ? // also see private_geojson for atomised data
          curr.private_location
        : curr.location
      console.info(`  datetime=${curr.time_observed_at}`)
      console.info(`  location=${loc}`)
      console.info(`  species=${curr.species_guess}`)
      const obsFields = curr.ofvs.map(e => `${e.name}=${e.value}`)
      obsFields
        .slice(0, 2) // only showing some of the values
        .forEach(e => console.info(`  ${e}`))
    }
    isMorePages = page < maxPages && page * pageSize < totalResults
    page += 1
  }
}

main().catch(err => {
  console.error('Failed with error', err)
  process.exit(1)
})
