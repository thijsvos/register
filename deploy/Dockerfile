# SPEC §07 — three stages to a runtime that is the binary plus git.
#
# §07 lists `scratch` here and `deploy/Dockerfile.release` still is one. This
# stage is not, and the difference is deliberate rather than drift: the status
# bar's GIT field (§02b Screen 1, carried by GET /api/tree per §04) is derived by
# shelling out to `git`, and a `scratch` image has no git to shell out to. So the
# field was pinned to `—` for every containerised vault no matter what state the
# repository was actually in — measured: the same binary against the same vault
# reported {"clean":false} on the host and null in the container, at the same
# moment. A field that can only ever say one thing is not chrome showing
# derivable truth; it is a dead pixel with a label.
#
# The published image keeps `scratch` on purpose. It carries no compiler and
# `RUN`s nothing, which is what lets buildx assemble both architectures without
# emulating either — adding `apk add` there would put a foreign-arch package
# install under QEMU on every release. `tests/release.rs` asserts both halves of
# this: the runtime stanza is identical, and the bases are meant to differ.
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

# Pinned to a release, never `latest` (§06 version doctrine). 3.24 is current
# stable — released 2026-06-09, supported to 2028-06-01.
FROM alpine:3.24
# The one reason this is not `scratch`. --no-cache leaves no index behind.
RUN apk add --no-cache git
COPY --from=server /build/target/release/register /register

# git refuses to read a repository whose owner does not match the calling uid
# ("detected dubious ownership"), and a bind-mounted vault keeps whatever owner
# it has on the host — which is the point of the compose file's `user:` line,
# and is not knowable at build time. Declared through the environment rather
# than a gitconfig file so it applies to whatever uid `docker run --user` picks,
# and scoped to the mount rather than `*`, so this trusts exactly the directory
# the operator already chose to hand us.
#
# This is for a Linux host. Docker Desktop reports a shared mount as owned by
# whichever uid asks — measured, uid 1000 sees 1000:0 and uid 501 sees 501:0 for
# the same path — so the mismatch cannot happen there and nobody developing on a
# Mac would ever find this missing. `tests/release.rs` pins it for that reason.
ENV GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=/vault

# A bare `docker run` should not be root. compose overrides this with the host
# user's own ids so the mounted vault comes out theirs; this is only the default
# for someone who runs the image directly. Numeric because it has to match the
# release image's, which is `scratch` and has no /etc/passwd to name anyone.
USER 1000:1000
VOLUME /vault
EXPOSE 7777
# 0.0.0.0 because a published port needs it, not because the server is meant to
# be reachable off the machine — inside the container it is the only way the
# published port reaches anything.
#
# `--allow-tokenless-network` is required because the binary now refuses that
# combination outright: the Host header the origin guard checks is chosen by the
# client, so on a real network a tokenless port is readable and writable by
# anyone who can reach it. What makes it safe *here* is the compose file, which
# publishes to 127.0.0.1 only. Widen that `ports:` line and this flag becomes a
# lie — add `--token-file` in the same edit.
ENTRYPOINT ["/register","serve","/vault","--host","0.0.0.0","--port","7777","--allow-tokenless-network"]
