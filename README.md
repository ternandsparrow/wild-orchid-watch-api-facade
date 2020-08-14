> a facade that sits in front of the iNat API so we can give access to WOW
> project data to trusted 3rd parties

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

# Why
TODO - write this. Talk about:
  - handling our own API keys
  - giving access to obscured coords to trusted parties
  - not giving write access to the WOW project (the alternative)
