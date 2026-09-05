# Installing REGISTER

The README's one-liner covers most people. This is everything else, and the
reasoning behind the parts that look odd.

## Docker

```sh
docker run -d --name register -p 127.0.0.1:7777:7777 \
  -v ~/vault:/vault ghcr.io/thijsvos/register:latest
```

`~/vault` need not exist and need not contain anything. Pointing the app at a
folder with no vault in it scaffolds one — `CLAUDE.md`, the daily stencil, an
inbox, the folders — and prints which files it wrote. Point it at a folder that
already holds markdown and it changes nothing, because a folder with markdown in
it is somebody's writing.

**On Linux add `--user $(id -u):$(id -g)`**, or every note is owned by uid 1000.
On macOS and Windows leave it off; Docker Desktop maps ownership to you whatever
the container says.

Every release publishes three tags — `vX.Y.Z`, `X.Y.Z` and `latest` — as one
manifest carrying `linux/amd64` and `linux/arm64`. `latest` exists so nobody has
to find a version string to try the product; **depend on a versioned tag**, which
is what `deploy/docker-compose.yml` names, and `tests/release.rs` fails the build
if that pin falls behind `Cargo.toml`. No version number is written here on
purpose: a number in prose is a pin nothing owns, and rule 11 says each one lives
in exactly one file. The rule against floating tags governs what this project
*consumes* — no `FROM …:latest`, no `uses: …@latest`.

Remove it with `docker rm -f register`. Your notes are on your own disk the whole
time; nothing is stored inside Docker.

## Compose

For something you keep running. `deploy/docker-compose.yml` pulls the published
image and has no `build:` in it, so it cannot accidentally compile:

```sh
cp deploy/.env.example deploy/.env     # then set VAULT_PATH
docker compose -f deploy/docker-compose.yml up -d
```

`VAULT_PATH` is required and has no default. It used to fall back to a folder
beside the compose file, which quietly put real notes inside the checkout;
compose now refuses to start and says what to set.

The compose file publishes on `127.0.0.1` only, so out of the box this reaches
the machine it runs on and nowhere else. Before widening the `ports` line, read
[remote.md](remote.md) — the container runs with `--allow-tokenless-network`,
which is safe *because* of that binding.

## Native

Prebuilt binaries for macOS (arm64/x64), Linux (x64/arm64, musl) and Windows x64
are attached to [every release](https://github.com/thijsvos/register/releases),
with `SHA256SUMS` beside them. Download one, make it executable, put it on your
`PATH`:

```sh
register init ~/vault --git   # folders, CLAUDE.md, .gitignore, git repo
register serve ~/vault        # UI on http://127.0.0.1:7777
```

`register serve` binds to loopback unless told otherwise. `register new "Title"`
creates a conforming note and prints its path — from inside a vault, or from
anywhere with `--vault ~/vault`. `register extract ~/vault` writes the vault and
its reader as one HTML file that opens from disk (see the README). `register
health` reports the toolchain.

`serve` scaffolds too, so `init` is only needed for `--git`.

## From source

```sh
cd app && pnpm build          # the UI is embedded in the binary
cd .. && cargo install --path . --force
```

`--force` is belt and braces. Cargo does replace an installed binary whose source
changed even without it — measured — but it has not always, the message it prints
when it declines is easy to miss, and the failure it prevents is the expensive
one: a fix that appears not to work because you are still running last week's
binary.

**Two install commands you will not find here, both deliberately.**

*No `cargo install --git`.* `app/dist/` is gitignored, so the checkout cargo
makes for itself has no UI to embed — and that build *succeeds*. It starts, it
serves `/api`, and it answers every page request with `no UI bundled; run cd app
&& pnpm build`: a working server behind a blank 404, which is a worse failure
than not compiling at all.

*No `cargo install register-notes`.* The name is not claimed on crates.io, and
printing an install command for a package someone else could publish is how you
get a supply-chain incident with your own README as the delivery mechanism.

## Working on the UI

The binary carries the UI inside it, so every change otherwise needs the full
reinstall above — and a stale binary looks exactly like a fix that did not work.
`--assets` skips it:

```sh
register serve ~/vault --assets app/dist    # from the repo root
```

Now `cd app && pnpm build` is enough; reload the browser and the change is there.
The server says so at startup, because this is the one mode where what you are
looking at is not what the binary would ship. For live reload while typing,
`pnpm dev` is faster — this is for seeing the *built* UI without paying for a
reinstall.

## Building the container

An overlay on the same compose file, so the default path stays incapable of
compiling:

```sh
docker compose -f deploy/docker-compose.yml \
               -f deploy/docker-compose.build.yml up -d --build
```

**`--build` is not optional here.** Without it compose reuses whatever image it
built last time, so your changes are simply absent and the symptom is identical
to the code not working. It cost an investigation before it was written down. The
overlay tags what it builds `register:source` rather than the published name, so
a local build cannot sit in the image store pretending to be the release.

**Two files, one image.** `deploy/Dockerfile` builds from source;
`deploy/Dockerfile.release` copies the binaries the release matrix already
cross-built on native runners, which is how one build publishes both
architectures without compiling Rust under emulation. Both end at the same
runtime — `alpine:3.24` plus `git`, about 25 MB — and `tests/release.rs` compares
their runtime stanzas line for line so the half nobody develops against cannot
drift.

`git` is in there because the status bar's GIT field is derived by shelling out
to it; on the `scratch` image this started as, that field read `—` however your
vault was stored. It costs one `RUN` per target architecture, so the release
workflow installs binfmt — the emulation is for `apk add` only, never for the
Rust build.

Live reload works through the bind mount: edit a note on the host and the watcher
inside the container reports it in about 15 ms, so an agent running on your
machine and the UI in the container stay in step. Agents always run on the
**host**, against the same mounted folder; the container only serves the UI.
