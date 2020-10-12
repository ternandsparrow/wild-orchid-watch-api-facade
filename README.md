> a facade that sits in front of the iNat API so we can give access to WOW
> project data to trusted 3rd parties

# Using the service
The data that WOW collects has obscured coordinates in order to protect the
orchids. It is important that the right people can access this data to make
informed decisions that may otherwise adversely affect a population of orchids.

Any public user can call the iNaturalist API directly and get data with the
obscured coordinates. This API allows trusted parties to access data with
accurate GPS coordinates. You need an API key in order to call this API.

This API is a facade in front of [`GET
/observations`](https://api.inaturalist.org/v1/docs/#!/Observations/get_observations)
from the iNaturalist API. Any params you can pass to that endpoint, we also
accept with the exception of `project_id`.

# Developer quickstart
  1. clone repo
  1. install dependencies `yarn`
  1. copy example dev start script
    ```bash
    cp dev-start.sh.example dev-start.sh
    ```
  1. edit dev start script to add required env vars
    ```bash
    vim dev-start.sh
    ```
  1. start server
    ```bash
    bash dev-start.sh
    ```
  1. hit the endpoint
    ```bash
    export API_KEY=abc123 # must be a value you defined in the dev-start.sh file
    curl -H "Authorization: $API_KEY" localhost:38080/wow-observations
    ```

# Useful links
  - [OAuth client config we use](https://www.inaturalist.org/oauth/applications/508)

# Why
TODO - write this. Talk about:
  - handling our own API keys
  - giving access to obscured coords to trusted parties
  - not giving write access to the WOW project (the alternative)
