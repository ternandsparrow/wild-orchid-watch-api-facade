> a facade that sits in front of the iNat API and provides a higher level of
> abstraction.

# Developer quickstart
  1. clone repo
  1. install dependencies `yarn`
  1. start server
    ```bash
    INAT_API_PREFIX=https://api.inaturalist.org/v1 yarn start
    ```
  1. point the WOW PWA to this instance by editing `.env.local`
    ```env
    # in your .env.local
    VUE_APP_FACADE_URL=http://localhost:38080
    ```

# Why
The existing iNat API is quite granular and to create a "full" observation we
need to make:
  - one request for the core observation
  - one request per photo
  - one request for observation field
  - one request to link to the iNat project

The observation fields are the number that blows out. A beginner mode
observation has 3 fields but a detailed observation has ~53 fields.

The problem comes when we try to make all these observations, one at a time
because that's how the Workbox background sync queue works. Mobile devices on
battery power will put the service worker to sleep before we get a chance to
make all the requests. Then we need to app to be opened again, and we need to
fire off any queued requests.

It's just hard to have a big enough window of time to upload everything.

# Solution
This is the solution. We'll run this facade as a serverless cloud function and
our users will make requests to this facade. The request will be a bundle of
everything needed to create the observation and this facade will make all the
individual requests.

The benefit of this approach is the client only needs to make one request so
there's less overhead and less chance of being put to sleep. It also simplies
the logic in the app.

# Challenges
## How fast can the iNat API respond?
We don't want to swamp the server if sending everything at once is too much. So
we need to find out what batch size we can use for obs fields and photos.

## Do we make the call synchronous for the client?
If we do make it synchronous, it make a few things easier:
  1. errors are obvious because we can send a non-200 to the client

However, there are some drawbacks:
  1. timeouts! Either from taking too long to send everything, or just waiting
     on the facade to respond.
  1. if the call fails, everything needs to be sent again, which is a waste of
     bandwidth

## Do we include photos?
Photos are easily the majority of the payload. They're also not essential for
the observation to be added to the project. Potentially we could use the facade
only for the "data" and photos can be attached via the existing API. Or we can
accept photos in the facade call but respond to the user once the core data is
done and keep processing the photos in the background (not sure if serverless
supports this).
