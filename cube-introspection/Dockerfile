# Cube's published image with the introspection package added. Cube itself is
# unchanged: the package is laid beside Cube's own packages, so it uses the very
# modules the image runs, and the image starts it instead of `cubejs server`.
#
# Build from this directory:
#
#   docker build -t cube:v1.7.45-introspection .
#
# CUBE_VERSION must be the version the package's peerDependencies name; the
# server refuses to start on any other.

ARG CUBE_VERSION=v1.7.45

FROM node:24.21.0-trixie-slim AS build

WORKDIR /package

COPY package.json package-lock.json ./
# Scripts build or download native binaries; compiling needs none of them.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build

FROM cubejs/cube:${CUBE_VERSION}

COPY --from=build /package/dist/src /cube/node_modules/cube-introspection/dist/src
COPY package.json NOTICE README.md /cube/node_modules/cube-introspection/

CMD ["node", "/cube/node_modules/cube-introspection/dist/src/bin/server.js"]
