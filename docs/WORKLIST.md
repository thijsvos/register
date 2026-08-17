# Worklist

Derived from [`ROADMAP.md`](ROADMAP.md), which stays canonical. Delete this file
when it is empty.

**All 58 non-expansion entries have now been read in full**, not sorted by title.
That distinction matters: the first pass at this file guessed from titles and put
seven items in "ready" that their own entries rule out, and the one entry I did
open — the "flaky" watch test — turned out to be described wrongly, which is why
it had sat unfixed for weeks.

**"I can do these now" is empty.** All ten are done and struck from the roadmap,
along with the three that preceded them: setext headings, `register new --vault`,
and that watch test. Emptying it prompted an audit — five readers over the
codebase, every candidate handed to an independent reader told to refute it —
which found sixteen more and closed fifteen; they are recorded under *Found by
audit after v0.6.3* rather than here, because they were fixed the same day they
were found. Four of them had shipped in the previous week's work.

What is below needs you, not time — so this file is now a list of questions
rather than a backlog, and the next thing to happen to it is answers.

Two of the ten changed shape while being built, and both are recorded in full on
the roadmap rather than here: the idle-RAM item ended in a measurement and two
options for §06 instead of an edit, because §06 is normative; and the cross-engine
item ended with webkit run locally rather than in CI, because three of its
failures reproduce only on Linux.

## Your call

**Empty.** All twenty-one were answered in one sitting on 2026-08-17 and the
rulings are recorded in `ROADMAP.md` under *Ruled on after v0.6.3*, each with
what was decided and why. Twenty are built; the twenty-first — per-screen
screenshot baselines — was ruled against, and the reasoning is there too.


## Not mine, or not yet understood

| Item | Why |
|---|---|
| The released binaries are unsigned | Needs your Apple Developer certificate, or a decision to use GitHub artifact attestations and document the verification story. |
| Remote mode has no TLS | Deliberate. A tailnet or a reverse proxy is the answer; §12 lists an encrypted-remote milestone. |
| An image arriving after the first measure | Three fixes measured to change nothing. The next step is understanding CodeMirror's height map, not a fourth guess. |
| The fixture only covers what someone thought to break | Wants a real vault from a real user. |
| The crumb rule is unfalsifiable | Blocked on the header actually narrowing, which is a different entry. |

## Expansion (§12)

Ten rows — query views, kanban, graph, plugins, importers, co-editing, richer
sync, native shells, encrypted remote, richer editing. Not defects and not a
todo list; they are the shape of a v2.

