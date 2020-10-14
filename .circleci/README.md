The `config.yml` file is based on [this
blog](https://circleci.com/blog/using-circleci-workflows-to-replicate-docker-hub-automated-builds/).

The follow env vars need to be configured in the CircleCI dashboard:
  - `GOOGLE_PROJECT_ID`: The Project ID for your Google Cloud project. This
       value can be retrieved from the project card in the Google Cloud Dashboard.
  - `GCP_PROJECT_KEY`: The base64 encoded (`base64 key-file.json`) [service
       account JSON
       key](https://cloud.google.com/iam/docs/creating-managing-service-account-keys)
  - `GOOGLE_COMPUTE_ZONE`: The value of the region to target your deployment.
      `us-west1` is a good mix of "passable ping to Australia" and still tier 1
      pricing.

