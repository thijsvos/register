# Remote access, and history

Both are off by default. Neither adds an account, a service, or any telemetry.

## Git checkpoints

If your vault is a git repository of its own, REGISTER can commit it for you
after it has been quiet for 90 seconds:

```jsonc
// .register/config.json
{ "checkpoints": true }
```

Commits are `checkpoint: 14:07Z`. It **never pushes** — that is a decision about
somebody else's repository — and it never commits a folder that merely *contains*
your vault, so a vault nested inside a larger repo checkpoints itself or not at
all. Nothing changed means nothing committed.

Turn it off by deleting the flag. Your history is ordinary git: `git log`,
`git revert`, `git checkout` all work, because there was never anything else.

**In the container, the GIT field works but checkpoints do not commit.** The
image carries `git` (it did not before v0.4.2, and the field read `—` however
your vault was stored), so the status bar reports your branch and its marks. But
`git commit` needs a `user.name` and `user.email`, the image sets neither, and
inventing an identity for somebody's history is not a default. Run `register
serve` natively if you want checkpoints, or pass an identity through compose.

### What the GIT field says

git's own shorthand, the way `git status --short` and every shell prompt write
it — `MAIN`, `MAIN ~3`, `MAIN ↑2 +1 ~3 ?4` — with a mark only when its count is
above zero: `+` staged, `~` modified, `?` untracked, `↑` commits ahead of an
upstream. `—` when the vault is not a repository, which is most of them.

## Remote mode

```sh
openssl rand -hex 24 > ~/.register-token
register serve ~/vault --host 0.0.0.0 --token-file ~/.register-token
```

`--token-file` rather than `--token`, because a command line is public: `ps`
shows it to every other user on the machine. `REGISTER_TOKEN` in the environment
works too and is nearly as good — on Linux `/proc/<pid>/environ` is readable by
the same user but not by others. `--token` still exists for a throwaway, and the
three are mutually exclusive.

Then open `http://<host>:7777/?token=<the token>` once. The token is stored as an
HttpOnly cookie, which is what carries it into the WebSocket — that API cannot
send an `Authorization` header, so a bearer-only scheme would leave live reload
either unauthenticated or unreachable. Scripts can use `Authorization: Bearer
<token>` instead.

The page then redirects to itself without the token, so the secret does not sit
in the address bar, in history, in a bookmark, or in the `Referer` of every link
you later click. The WebSocket is exempt: it cannot follow a redirect, and
`?token=` is how it authenticates before any cookie exists.

Binding a real interface with no token is **refused at startup**, because the
origin guard alone does not cover it: the `Host` header it checks is chosen by
the client, which stops a browser being rebound onto your loopback but stops
nothing that speaks HTTP directly. `--allow-tokenless-network` overrides the
refusal when something else already limits who can reach the port — which is
exactly why the compose file may use it while publishing to `127.0.0.1` only.

**Localhost stays tokenless.** A request that reached 127.0.0.1 came from the
machine the vault is on, where the files are readable anyway.

## Behind Tailscale is the intended shape

§07's recommendation. Put the machine on your tailnet and bind to its tailnet
address rather than to the whole world:

```sh
register serve ~/vault --host "$(tailscale ip -4)" --token "$(openssl rand -hex 24)"
```

Every device you own reaches it; nothing else can route to it at all. The token
is then a second lock rather than the only one. There is no TLS here — a tailnet
is already encrypted, and terminating TLS is your reverse proxy's job if you put
one in front.

No accounts. No user table. No telemetry. The token is a string you chose,
compared in constant time, and forgotten when the process exits.

## Widening the container's port

The compose file publishes on `127.0.0.1`. Three things before you change that:

- The container binds `0.0.0.0` because a published port needs it, not because
  the server is meant to be reachable from a network. The Origin and Host guards
  still hold and `/api/reveal` refuses outright on a non-loopback bind — but
  putting this on a network is a decision.
- Widening the `ports` line means adding a token **in the same edit**. A browser
  reaching it by the host's LAN address gets 403 from the Host guard, but that
  guard is a browser-integrity check and any non-browser client simply sets the
  header. Give it a real credential:
  `command: ["--token-file", "/vault/.register/token"]`, appended to the image
  ENTRYPOINT.
- Agents still run on the host, against the same mounted folder.
