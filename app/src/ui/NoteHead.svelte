<script lang="ts">
import { fields, hasFrontmatter, rawFields } from '../core/frontmatter'
import { basename } from '../core/paths'
import { vault } from '../core/store.svelte'

/**
 * §02b Screen 1's document header — what the frame draws above the body:
 *
 *     NOTE · REF 003 · REV 07
 *     Terminal aesthetics  (sentence)
 *     ┌created┬modified┬words┬status┐
 *
 * The strip is not built, and that is a maintainer's ruling rather than an
 * oversight. It was, briefly: `created` and `modified` are now editable rows in
 * the inspector's PROPERTIES pane, which put the same two values on screen
 * twice, and `words` and `chars` are readouts that belong in the status rail
 * with RENDER — §08 P4 names all three in one breath. REV and STATUS could
 * never be built at all: §04's note format is `id / ref / title / created /
 * modified / tags`, so there is no revision number and no status anywhere in a
 * vault, and §02b's own fidelity rule forbids "a gauge [that] display[s] a
 * number the system cannot measure". In `register-prototype.html` both were
 * literal fixture strings.
 *
 * What is left is the note saying what it is: its ref, and its title in the
 * writer's own sentence case. `docs/ROADMAP.md` carries the deviation.
 *
 * Read from the buffer rather than from the tree, for the inspector's reason: a
 * title changes as it is typed, and the corpus is a save behind.
 */
let front = $derived(fields(vault.buffer))
let ref = $derived(front.get('ref') ?? '')

// The kicker names the note. A ref that is not there earns no dash — `017-bare`
// in the compat fixture has none, and `NOTE · REF —` would report an absence
// nobody asked about. The crumb above still shows the ref field's own dash.
let kicker = $derived(ref === '' ? 'Note' : `Note · Ref ${ref}`)

// Sentence case, per the frame, so this is the one heading in the app that is
// not uppercased by CSS: it is the writer's words, not the instrument's.
let title = $derived(front.get('title') || basename(vault.openPath ?? ''))

/**
 * The server could not read this note's frontmatter.
 *
 * A note whose YAML does not parse degrades to `title: null, tags: []` — which
 * is right, because one bad note must not take `/api/tree` down, and is pinned
 * by contract. What was missing was any way to *learn* of it: the index draws
 * such a note exactly like one that simply has no title, so it is silent and
 * permanent, and the note's tags are quietly absent from the tag index too.
 *
 * Derived rather than reported, because reporting it means a new field in §04's
 * tree envelope. The three facts together are conclusive: the file has a
 * frontmatter block, that block *has* a `title:` line, and the server still says
 * this note has no title. Nothing but a parse failure produces that.
 *
 * `rawFields` is a line-wise regex rather than a YAML parser, so it reads the
 * key the server choked on — which is exactly what makes the comparison work.
 */
let unreadable = $derived(
  vault.openPath !== null &&
    hasFrontmatter(vault.buffer) &&
    rawFields(vault.buffer).has('title') &&
    vault.active !== null &&
    vault.active.title === null,
)
</script>

<header class="note">
  <div class="stamp">{kicker}</div>
  <h2>{title}</h2>
  {#if unreadable}
    <p class="unreadable">
      This note's frontmatter did not parse, so its title and tags are not being
      read. A colon or a <code>#</code> in a value usually wants quoting.
    </p>
  {/if}
</header>

<style>
/* Said where the note is, rather than in the index: a reader learns of this
   while looking at the thing it is about, and the alternative — a state on the
   index row — is a §04 envelope change for a condition that is rare and already
   non-destructive. Hairline and dim, never the signal colour: nothing here is
   live, and §02 keeps the accent for the edge of what is happening. */
.unreadable {
  margin-top: var(--s2);
  border-left: var(--hairline) solid var(--line);
  padding-left: var(--s3);
  color: var(--dim);
  font-size: var(--text-ui);
}

/* Measured and padded exactly as `.cm-content` is (editor/theme.ts), so the
   kicker and the title sit on the body's own left edge rather than on the
   pane's. */
.note {
  /* `width: 100%` and not `auto`, which looks redundant on a block and is not:
     this is a grid item, and an item with auto margins does not stretch — it
     is shrink-to-fit, and the auto margins then centre whatever width its
     content happened to want. The strip used to be the widest thing in here
     and propped it out to the measure by accident; taking the strip away left
     the title centred on itself, sitting 116px right of the prose. Measured. */
  width: 100%;
  max-width: var(--measure);
  margin: 0 auto;
  padding: var(--s5) var(--s5) 0;
}

.stamp {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}

h2 {
  font-size: var(--text-title);
  font-weight: 700;
  color: var(--hi);
  /* Half of what it was. The gap to the first line is made of two paddings —
     this one and `.cm-content`'s top inset — which together measured 48px, and
     the title read as belonging to the frame rather than to the note under it.
     Both halved rather than one zeroed, so the title keeps a little room of its
     own and the body keeps its inset from the rule above. */
  padding: var(--s1) 0 var(--s2);
}
</style>
