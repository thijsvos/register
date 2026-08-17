### Container image · third-party software

`ghcr.io/thijsvos/register` is built on `alpine:3.24` with `git` installed, so
pulling it obtains Alpine Linux packages alongside REGISTER. Ten of them are
**GPL-2.0-only** — `git`, `git-init-template`, `busybox`, `busybox-binsh`,
`ssl_client`, `apk-tools`, `libapk`, `alpine-baselayout`,
`alpine-baselayout-data`, `scanelf` — with `libidn2` and `libunistring` under
GPL-2.0-or-later and `ca-certificates-bundle` under MPL-2.0. The rest are MIT,
Apache-2.0, BSD-3-Clause, Zlib or curl.

**Corresponding source for all of them is published by Alpine Linux** at
<https://gitlab.alpinelinux.org/alpine/aports> and mirrored per release at
<https://dl-cdn.alpinelinux.org/alpine/v3.24/>. This image adds nothing to those
packages and modifies none of them.

REGISTER itself is MIT (`LICENSE`) and is unaffected: it runs `git` as a
subprocess rather than linking it, and an image is aggregation rather than a
combined work. The released **binaries** carry no GPL software at all — their
dependency graph is entirely permissive.

Full inventory, and the command that reproduces it, in
[`THIRD-PARTY.md`](https://github.com/thijsvos/register/blob/main/THIRD-PARTY.md).
