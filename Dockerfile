FROM node:12-slim
ARG GIT_SHA

USER node
RUN mkdir -p /home/node/app
WORKDIR /home/node/app

# split the deps install from other code for faster future builds
COPY --chown=node package.json yarn.lock ./
RUN yarn install --frozen-lockfile --prod

COPY --chown=node . .

ENV HOST=0.0.0.0 PORT=3000 GIT_SHA=${GIT_SHA}

EXPOSE ${PORT}
CMD [ "node", "." ]
