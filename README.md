> a facade that sits in front of the iNat API so we can give access to WOW
> project data to trusted 3rd parties

# Using the service
The observations that
[WOW](https://github.com/ternandsparrow/wild-orchid-watch-pwa/) collects has
coordinates obscured in order to protect the orchids. It is important that the
right people can access the accurate coordinates to make informed decisions that
may otherwise adversely affect a population of orchids.

Any public user can call the iNaturalist API directly and get data with the
obscured coordinates. This API facade allows trusted parties to access data with
accurate GPS coordinates. You need an API key in order to call this API.

This API is a facade in front of [`GET
/observations`](https://api.inaturalist.org/v1/docs/#!/Observations/get_observations)
from the iNaturalist API. Any params you can pass to that endpoint, we also
accept with the exception of `project_id` as this is set to the WOW project.

# Example clients
We have prepared some example clients in some common programming languages to
show how can consume this API. See the examples in
[example-clients](./example-clients/):

  - [Java](./example-clients/java/)
  - [NodeJS](./example-clients/nodejs/)
  - [Python](./example-clients/python/)

This is just a JSON over HTTP API so consume it however best suits you.

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

# A technical discussion about why we need this
The WOW project needs to ability the for trusted third parties (government
departments, etc) to access the observations from the project, including
accurate geolocation details.

The only user accounts that have access to the accurate coordinates for an
observation are:
  - the owner
  - curators/managers of the WOW project
  - other trusted users, but using this mechanism isn't feasible

We can use that curator/manager mechanism but those accounts have other power
within the iNat project like editing the project settings. We *only* want to
expose the *read* access, but not *write* access. This means we cannot simply
create iNat accounts for our third party clients and make those accounts
curators.

Creating a facade to the existing iNaturalist API solves this problem because
the facade can use a user account that is a curator in the project, but only
expose the functionality that we want. It also allows us to:
  - issue our own API keys, one for each client.
  - only allow *read* action (`GET`)
  - only return observations within the WOW project (without the client having
      to explicitly pass a `project_id=` parameter)
  - have the option to transform the response if it means a better UX for our
      clients

Basically this facade lets us give a better experience to our third party
clients.

# Design decisions
*CORS*: no CORS support is provided on the `/wow-observations` endpoint because
this API is intended to be consumed machine-to-machine clients, not from a
browser.

*Google Cloud Run*: using this over Cloud Functions means we can create a
container with everything we need. This means there's no vendor lock-in and
running locally during dev is easy (although the tooling for functions is
perfectly fine there too). It also means that our container can handle multiple
requests so we won't churn through OAuth keys as fast as function might.

*Google Cloud Secrets*: this lets us store secrets in a way that makes them
readable to authorised users. CircleCI env vars cannot be read back, which is
annoying for the client API keys that we issue. We've chosen to keep the Docker
container agnostic of GCP and instead inject the values at deploy time. Adding
a GCP client *into* the container would make local dev a bit more cumbersome.
