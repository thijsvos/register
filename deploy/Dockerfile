# SPEC §07 — three stages to `scratch`, so the image is the binary.
#
# Two deviations from §07's listing, both required by §06's own version
# doctrine ("each version lives in exactly one file, everything else references
# it"):
#
#   - pnpm is read from app/package.json's `packageManager` field rather than
#     written here. §07 says `pnpm@10`; the repo pins 11.20.0, and a hardcoded
#     10 installs a pnpm that cannot read this lockfile. A third copy of a
#     version is a third thing to forget.
#   - `--locked` on the cargo build, matching CI's `--frozen-lockfile`. A
#     release image that silently resolved a different dependency graph than the
#     one that was tested is not the thing that was tested.

FROM node:24-alpine AS ui
WORKDIR /build/app
# Manifests first: this layer is the install, and it should only be invalidated
# when the dependencies actually move.
COPY app/package.json app/pnpm-lock.yaml ./
RUN npm i -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
 && pnpm install --frozen-lockfile
COPY app/ .
RUN pnpm build

FROM rust:1.97-alpine AS server
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY --from=ui /build/app/dist ./app/dist
# Static musl by default on this image; `scratch` below has no loader, so a
# dynamically linked binary would fail to start with no message at all.
RUN cargo build --release --locked

FROM scratch
COPY --from=server /build/target/release/register /register
VOLUME /vault
EXPOSE 7777
# 0.0.0.0 because the port is published from a container, not because the
# server is meant to be reachable off the machine. §04 refuses /api/reveal on a
# non-loopback bind for exactly this case, and the Origin and Host guards still
# stand — but publishing this port to a network is a decision, not a default.
ENTRYPOINT ["/register","serve","/vault","--host","0.0.0.0","--port","7777"]
