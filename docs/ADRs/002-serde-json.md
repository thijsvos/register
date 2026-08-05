# ADR-002 — `serde_json` as a named dependency

- **Status:** accepted, 2026-08-05
- **Affects:** P2 (`server.rs`)

## Context

§04's architecture table names `serde` but not `serde_json`, while also
specifying a REST API that returns JSON and a WebSocket carrying
`{created|changed|removed, path, etag}` frames. The omission is an oversight in
the table, not a decision: there is no way to serve the specified API without a
JSON serializer.

`serde_json` is already compiled into the binary regardless. axum's `json`
feature — on by default, and required for `axum::Json` — depends on it. So this
adds nothing to the dependency graph, the build time, or the §06 10 MB budget.
`cargo tree` shows it either way.

What changes is only whether we may *name* it. `axum::Json` covers the three
HTTP responses without naming it, but the WebSocket pump serializes frames
itself, and axum offers no `Json`-equivalent for a socket message.

## Decision

Add `serde_json = "1"` to `[dependencies]` and call `serde_json::to_string` in
the WS pump.

## Alternatives considered

**Hand-write the JSON for `watch::Event`.** The struct is three fields, so this
is tempting and would keep the manifest to §04's literal list. Rejected: it
means hand-rolling string escaping for a `path` that is arbitrary user input and
can legitimately contain quotes, backslashes and control characters. Writing a
bespoke escaper to avoid naming a crate that is already linked trades a real
correctness risk for a cosmetic one.

**Serialize the frame with `serde-saphyr`.** It is deserialize-only here per
ADR-001, and YAML frames would not match §04's API anyway.

## Consequences

- §04's architecture table should gain `serde_json` at the next spec revision,
  alongside the `serde_yaml` correction ADR-001 already implies. Documentation
  debt, not a version event — the vault format is untouched.
- No new licence obligations: `serde_json` is MIT OR Apache-2.0 and we take the
  MIT arm, matching the rest of the tree.
