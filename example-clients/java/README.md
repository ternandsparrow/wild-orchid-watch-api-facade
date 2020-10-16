# Using Docker
If you don't have `gradle` and `java` installed on your system, but you do have
Docker, you can run all of this in a Docker container. To do that, run the
`docker-shell.sh` script to launch a bash shell inside the container that has
the tools you need. This directory will be volume mounted into the Docker
container too.

# Run the example
  1. clone this repo
  1. change into this directory
      ```bash
      cd example-clients/java
      ```
  1. optionally, launch a shell in a docker container
      ```bash
      ./docker-shell.sh
      ```
  1. set the API key env var
      ```bash
      export API_KEY=abc123 # replace with real key
      ```
  1. run the example
      ```bash
      ./gradlew run
      ```
