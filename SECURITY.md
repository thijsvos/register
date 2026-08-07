# Security

## Reporting

Use GitHub's [private vulnerability reporting][pvr] on this repository —
**Security → Report a vulnerability**. Please do not open a public issue for
anything you think is exploitable.

[pvr]: https://github.com/thijsvos/register/security/advisories/new

If that link 404s, private reporting has not been switched on yet; open an issue
saying only *"security, please enable private reporting"* — with no detail — and
it will be. Reporting a hole in the reporting channel is a fair first finding.

This is a single-maintainer project, so the honest answer on timing is: I will
acknowledge within a week, and I will tell you what I actually intend to do
rather than quote you a policy. If you want to publish on your own schedule,
say so and I will work to it.

## What this software is, in threat terms

REGISTER is one binary that reads and writes a folder of markdown and serves it
over HTTP. By default it binds `127.0.0.1:7777` and requires no credential,
because a process that reached loopback is already on a machine where those
files are readable anyway.

That default is the whole security model. Everything below is about what happens
when you move away from it.

**In scope, and interesting:**

- Anything that reads or writes a file outside the vault — path traversal, a
  symlink escaping through the vault or through `--assets`, a `..` that survives
  `Vault::resolve`.
- Anything letting a web page you merely *visit* reach the local server: a gap in
  the Origin check, in the DNS-rebinding `Host` check, or in the WebSocket
  upgrade (which CORS does not constrain).
- Anything letting a request that has not presented `--token` be treated as
  though it had. This has happened once: the marker that waives the `Host` and
  `Origin` rules was set from the peer address rather than from a presented
  credential, so on a `--host 0.0.0.0` bind every stranger inherited it.
- A hostile `.md` file in a vault causing anything worse than bad rendering.
- Anything that makes `register` write outside the vault, execute a subprocess it
  should not, or leak the token.

**Out of scope:**

- Anything requiring an attacker who already runs code as you. They can read the
  vault directly; the server is not the boundary.
- The tokenless loopback default itself. It is a documented decision (§08 P12,
  "localhost stays tokenless"), not an oversight. A same-host reverse proxy
  inherits that exemption and must therefore carry its own authentication — no
  `X-Forwarded-*` header is trusted, deliberately.
- Denial of service against your own local server.
- Missing hardening headers with no demonstrated exploit against this app.

## If you expose it beyond localhost

`--host 0.0.0.0` without a token is **refused at startup**, and the refusal is
the point: the `Host` header the origin guard checks is chosen by the client. It
stops DNS rebinding — a browser cannot lie about it — and it stops nothing at all
from `curl`. This was measured, not assumed: before the refusal existed, one
`-H 'Host: localhost'` from a LAN address gave a peer read, write and delete on
the whole vault, and this file used to claim the opposite.

`--allow-tokenless-network` overrides it, for the case where something else
already decides who can reach the port — a container published to loopback, a
firewall. The container ships with that flag for exactly that reason, and its
compose file publishes on `127.0.0.1`. Widen that `ports:` line and the flag
becomes a lie; add a token in the same edit.

The intended shape is a token, behind Tailscale rather than the open internet.

Pass the token as `--token-file` or `REGISTER_TOKEN`; `--token` on the command
line is visible in `ps` to every other user on the machine.

## What ships

The release binary statically links its crates and embeds the UI, so an advisory
against any of them is an advisory against the binary. CI runs `cargo audit` on
every change and `pnpm audit --prod` on the packages that ship. Third-party
components and their licences are listed in [THIRD-PARTY.md](THIRD-PARTY.md).
