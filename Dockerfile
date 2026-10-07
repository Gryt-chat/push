FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --ignore-engines

COPY . .
RUN yarn build

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim

RUN groupadd -g 1001 gryt && useradd -m -u 1001 -g 1001 -d /app -s /usr/sbin/nologin gryt
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

# No runtime dependencies: http2, sqlite and the signing all come with Node.
COPY --from=builder --chown=gryt:gryt /app/package.json ./package.json
COPY --from=builder --chown=gryt:gryt /app/dist ./dist

ARG PUSH_VERSION=dev
ENV PUSH_VERSION=$PUSH_VERSION

RUN mkdir -p /data && chown gryt:gryt /data
VOLUME /data
USER gryt
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
