The `config.yml` file is based on [this
blog](https://circleci.com/blog/using-circleci-workflows-to-replicate-docker-hub-automated-builds/).

The following env vars need to be configured in the CircleCI dashboard. These
are used for the build and deploy process:
  - `GOOGLE_PROJECT_ID`: The Project ID for your Google Cloud project. This
       value can be retrieved from the project card in the Google Cloud Dashboard.
  - `GCP_PROJECT_KEY`: The base64 encoded (`base64 key-file.json`) [service
       account JSON
       key](https://cloud.google.com/iam/docs/creating-managing-service-account-keys).
       This account must have the permission listed below.
  - `GOOGLE_COMPUTE_ZONE`: The value of the region to target your deployment.
      `us-west1` is a good mix of "passable ping to Australia" and "still tier 1
      (cheap) pricing".
  - `DOCKER_USERNAME`: username to login to Docker Hub so we don't get rate
      limited pulling images
  - `DOCKER_PASSWORD`: password to login to Docker Hub

You also need to configure the secrets that the app will use at runtime. These
are the env vars that you see in the `../dev-start.sh.example` file. They are
configured as [Google Cloud
Secrets](https://cloud.google.com/secret-manager/docs/creating-and-accessing-secrets).
*Importantly* these are only read during deploy. So if you **change a value**,
you must re-deploy the service (from CircleCI) to have it read and configure
the new values. You should create the secrets with the same name as the env
vars, e.g. `INAT_API_PREFIX`. The deploy script will read the *latest* value.

## Permissions required for service account
This list is almost certainly too permissive, but it does work. It uses some
Google managed roles to quickly get some permissions but this should be pared
down to only the essential permissions.

  - secretmanager.versions.access
  - storage.buckets.create
  - storage.buckets.get
  - storage.buckets.list
  - roles/iam.serviceAccountUser
  - roles/run.admin
  - roles/storage.objectAdmin
