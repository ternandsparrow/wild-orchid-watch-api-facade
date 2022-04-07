FROM node:16-buster-slim
ARG GIT_SHA

RUN set -eux; \
  apt-get update -y \
  && pkgs='gnupg curl' \
  && apt-get install -y $pkgs \
  && debVersion=$(cat /etc/apt/sources.list | grep -v '^#' | head -n1 | cut -f3 -d' ') \
  && gcsFuseRepo=gcsfuse-${debVersion} \
  && echo "deb http://packages.cloud.google.com/apt $gcsFuseRepo main" | \
    tee /etc/apt/sources.list.d/gcsfuse.list \
  && curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | \
    apt-key add - \
  && apt-get update \
  && apt-get install -y gcsfuse tini \
  && apt-get remove -y $pkgs \
  && apt-get -y autoremove \
  && apt-get clean \
  && gcsfuse --version

USER node
ENV APP_HOME=/home/node/app  UPLOAD_DIR_PATH_DOCKER=/home/node/gcs
RUN mkdir -p $APP_HOME $UPLOAD_DIR_PATH_DOCKER
WORKDIR $APP_HOME

# split the deps install from other code for faster future builds
COPY --chown=node package.json yarn.lock ./
RUN yarn install --frozen-lockfile --prod

COPY --chown=node . .
RUN chmod +x entrypoint.sh

ENV HOST=0.0.0.0  PORT=3000  GIT_SHA=${GIT_SHA}

EXPOSE ${PORT}
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "./entrypoint.sh" ]
