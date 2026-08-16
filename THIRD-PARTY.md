# Third-party software

REGISTER ships two artefacts. The release binary is self-contained: it
statically links its Rust dependencies and embeds the built UI — JavaScript,
CSS and the three fonts — with `rust-embed`.

**The container image is not, and this file said it was for longer than it
should have.** It was `scratch` — the binary and nothing else — until the GIT
field turned out to be underivable there: that state comes from shelling out to
`git`, and a `scratch` image has no git, so the field read `—` in every
container however the vault was stored. The image is now `alpine:3.24` plus
`apk add git`, which redistributes an operating system's worth of software,
including copyleft components the `scratch` image did not carry. What that means
is set out under [Container image](#container-image) below.

`node:24-alpine` and `rust:1.97-alpine` appear in `deploy/Dockerfile` as build
stages only; neither reaches the published image.

Everything redistributed is listed below. REGISTER itself is MIT (`LICENSE`);
nothing here alters that.

## Container image

`ghcr.io/thijsvos/register` is `alpine:3.24` with `git` installed from Alpine's
`main` repository, and it carries git's own dependency closure with it. Twenty-
eight packages, reproducible with:

```sh
docker run --rm alpine:3.24 sh -c \
  'apk add --no-cache git >/dev/null && apk info --license $(apk info)'
```

| Licence | Packages |
|---|---|
| GPL-2.0-only | `git`, `git-init-template`, `busybox`, `busybox-binsh`, `ssl_client`, `apk-tools`, `libapk`, `alpine-baselayout`, `alpine-baselayout-data`, `scanelf` |
| GPL-2.0-or-later | `libidn2`, `libunistring` |
| MPL-2.0 | `ca-certificates-bundle` |
| Apache-2.0 | `libcrypto3`, `libssl3` |
| MIT | `musl`, `musl-utils`, `alpine-keys`, `alpine-release`, `brotli-libs`, `c-ares`, `libexpat`, `libpsl`, `nghttp2-libs` |
| BSD-3-Clause | `pcre2`, `zstd-libs` |
| Zlib | `zlib` |
| curl | `libcurl` |

**This does not affect REGISTER's own licence.** The `register` binary is a
separate program that talks to `git` by running it as a subprocess — the arm's
length the GPL's own FAQ describes — and an image is aggregation on a storage
medium, not a combined work. REGISTER stays MIT and links none of the above.

What it does mean is that pulling this image obtains GPL-2.0 software, and the
corresponding source for every package above is published by Alpine at
<https://gitlab.alpinelinux.org/alpine/aports> and mirrored alongside each
release at `https://dl-cdn.alpinelinux.org/alpine/v3.24/`. Alpine distributes
both, which is the ordinary way a derived image discharges this; whether to add
an explicit written offer to the release notes is a call for the maintainer and
is noted in `docs/ROADMAP.md`.

Neither `deploy/Dockerfile` nor `deploy/Dockerfile.release` installs anything
else, and `tests/release.rs` compares their runtime stanzas line for line, so
this list cannot grow in one image without growing in the other.

## Rust crates

122 crates sit on normal-kind dependency edges from `register-notes`, unioned
across the five release targets (`aarch64-apple-darwin`, `x86_64-apple-darwin`,
`aarch64-unknown-linux-musl`, `x86_64-unknown-linux-musl`,
`x86_64-pc-windows-msvc`). 111 of them compile into a binary; any single target
links 101–106, and the spread is platform backends — `fsevent-sys` on macOS,
`inotify` on Linux, `windows-sys` on Windows. The other 11 are the five derive
macros (`serde_derive`, `clap_derive`, `thiserror-impl`, `tokio-macros`,
`rust-embed-impl`) and the crates only they reach; those run on the host at
build time and their code is not in the shipped binary. Dev-dependencies and
build-only crates are excluded — they are never redistributed.
`cargo metadata --format-version 1` over `Cargo.lock` reproduces the list.

The graph is entirely permissive. Nine licences appear across it — MIT,
Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unlicense, BSL-1.0, Unicode-3.0,
CC0-1.0 — and none is copyleft, weak or strong. No crate restricts commercial
use or requires source disclosure.

114 of the 122 offer a plain MIT arm and are discharged by the notices carried
in their own sources. The remaining eight are not, and are listed in full. Each
is either conjunctive — an `AND`, where every term applies at once and you
cannot elect the friendliest — or has no MIT arm to elect.

**encoding_rs 0.8.35** — `(Apache-2.0 OR MIT) AND BSD-3-Clause`
The BSD-3-Clause term is not optional: the encoding tables derive from the
WHATWG specification, so the WHATWG copyright notice and its no-endorsement
clause must be reproduced in binary distributions (`LICENSE-WHATWG` in the
crate). Reached through `encoding_rs_io`.

**matchit 0.8.4** — `MIT AND BSD-3-Clause`
axum's router. Its radix tree is a port of Go's httprouter, so Julien Schmidt's
BSD-3-Clause notice applies on top of the MIT one and must travel with binary
form (`LICENSE.httprouter`).

**unicode-ident 1.0.24** — `(MIT OR Apache-2.0) AND Unicode-3.0`
The identifier tables are Unicode data, and Unicode-3.0 requires the Unicode,
Inc. copyright and permission notice to accompany them (`LICENSE-UNICODE`).
Reached only through `proc-macro2`, so the tables are consumed by the derive
macros at build time and do not reach the binary — listed because the term is
in the graph.

**notify 8.2.0** — `CC0-1.0`
The file watcher. CC0 is a public-domain dedication rather than a licence and
asks for nothing. Named because it inherits no MIT notice, and a reader
scanning for one would otherwise find nothing.

**inotify 0.11.4** — `ISC`
**inotify-sys 0.1.8** — `ISC`
notify's Linux backend; they link into the Linux builds only. ISC requires the
copyright notice and the permission notice to appear in all copies.

**ryu 1.0.23** — `Apache-2.0 OR BSL-1.0`
Float formatting, reached through `serde_urlencoded`. Neither arm is MIT.
Apache-2.0 requires the licence text and retention of notices; BSL-1.0 requires
its notice only for source distribution, which makes it the lighter election
for a binary.

**sync_wrapper 1.0.2** — `Apache-2.0`
Used by axum and tower. Apache-2.0 with no alternative arm: requires a copy of
the licence and retention of the crate's notices. It ships no `NOTICE` file, so
there is no NOTICE text to propagate.

## JavaScript

The UI bundle embedded in the binary. These are the runtime `dependencies` in
`app/package.json`, plus Svelte — a devDependency, but its client runtime
helpers compile into the shell chunk and therefore ship.

| Package | Version | Licence |
|---|---|---|
| `@codemirror/commands` | 6.10.4 | MIT |
| `@codemirror/language` | 6.12.4 | MIT |
| `@codemirror/state` | 6.7.1 | MIT |
| `@codemirror/view` | 6.43.7 | MIT |
| `@lezer/highlight` | 1.2.3 | MIT |
| `@lezer/markdown` | 1.7.2 | MIT |
| `minisearch` | 7.2.0 | MIT |
| `svelte` | 5.56.8 | MIT |

Their runtime transitives ship too, and are also MIT: `@lezer/common` 1.5.2,
`@lezer/lr` 1.4.10, `@marijn/find-cluster-break` 1.0.3, `crelt` 1.0.7,
`style-mod` 4.1.3 and `w3c-keyname` 2.2.8 behind CodeMirror; `clsx` 2.1.1 and
`esm-env` 1.2.2 behind Svelte's client runtime.

Nothing in the shipped JavaScript is under anything but MIT. Svelte's compiler
dependencies include two Apache-2.0 packages, `aria-query` and
`axobject-query`, and one more MIT one, `devalue`, that is server-render only;
the compiler runs at build time and none of the three appears in any output
chunk.

## Fonts

Three faces are self-hosted and embedded. All are SIL Open Font License 1.1,
and each ships its `OFL.txt` in the same directory as the `.woff2`. The binary
serves them at `/fonts/<face>/OFL.txt`, so the licence text is present in every
running instance, not only in the repository.

| Face | Copyright | Served at |
|---|---|---|
| Commit Mono (400, 700) | © 2023 Eigil Nikolajsen | `/fonts/commit-mono/` |
| Departure Mono (400) | © 2022–2024 Helena Zhang | `/fonts/departure-mono/` |
| Server Mono (400, 400 oblique) | © 2024 Internet Development Studio Company | `/fonts/server-mono/` |

OFL-1.1 permits redistribution bundled with software provided the licence
travels with the fonts and the Reserved Font Names are not reused by modified
versions. The files here are unmodified and are not sold on their own.

TX-02 / Berkeley Mono sits first in `--font-ui` but is commercial and is not in
this repository. It resolves only if the user already has it installed, or
through the bring-your-own-font loader, which writes into the vault's
`.register/fonts/` — user files, never redistributed.
