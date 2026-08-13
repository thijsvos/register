<script lang="ts">
import { fields } from '../core/frontmatter'
import { basename } from '../core/paths'
import { vault } from '../core/store.svelte'
import { chromeStamp } from '../lib/time'

/**
 * §02b Screen 1's document header — the three rows the frame draws above the
 * body:
 *
 *     NOTE · REF 003 · REV 07
 *     Terminal aesthetics  (sentence)
 *     ┌created┬modified┬words┬status┐
 *
 * Two of the four cells are not built, and deliberately. §04's note format is
 * `id / ref / title / created / modified / tags` — there is no revision number
 * and no status anywhere in the vault, and §02b's own fidelity rule says
 * "chrome shows only derivable truth. No gauge may display a number the system
 * cannot measure". In `register-prototype.html` both are literal fixture
 * strings. So the strip keeps its four cells and spends the fourth on `chars`,
 * which §08 P4 asks for in the same breath as `words` and which nothing in the
 * app had ever shown. REV and STATUS want a §04 revision under hard rule 1;
 * `docs/ROADMAP.md` carries the entry.
 *
 * Read from the buffer rather than from the tree, for the Inspector's reason:
 * a title changes as it is typed, and the corpus is a save behind.
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

const dash = '—'
let created = $derived(chromeStamp(front.get('created') ?? '') || dash)
let modified = $derived(chromeStamp(front.get('modified') ?? '') || dash)
</script>

<header class="note">
  <div class="stamp">{kicker}</div>
  <h2>{title}</h2>
  <dl class="meta">
    <!-- `title` for the inspector's reason: a hand-written field can be any
         length, and a value the cell has to clip should still be readable. -->
    <div class="cell">
      <dt>Created</dt>
      <dd title={created}>{created}</dd>
    </div>
    <div class="cell">
      <dt>Modified</dt>
      <dd title={modified}>{modified}</dd>
    </div>
    <div class="cell">
      <dt>Words</dt>
      <dd class="num">{vault.openWords ?? dash}</dd>
    </div>
    <div class="cell">
      <dt>Chars</dt>
      <dd class="num">{vault.openChars ?? dash}</dd>
    </div>
  </dl>
</header>

<style>
/* Measured and padded exactly as `.cm-content` is (editor/theme.ts), so the
   kicker, the title and the strip sit on the body's own left edge rather than
   on the pane's. */
.note {
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
  padding: var(--s1) 0 var(--s4);
}

/* The frame draws it as a box with a divider between each cell. Four equal
   columns is what the sketch looks like and it is wrong in practice: a §04
   `modified` is twenty characters and a word count is two, so equal shares
   ellipsised the only cell anyone has to read — measured, `2026-08-05 0…`.
   Weighted by what each cell actually holds instead. */
.meta {
  display: grid;
  grid-template-columns:
    minmax(0, 1fr) minmax(0, 1.55fr)
    minmax(0, 0.7fr) minmax(0, 0.75fr);
  border: var(--hairline) solid var(--line);
}
.cell {
  padding: var(--s2) var(--s3);
  border-right: var(--hairline) solid var(--line);
  /* A grid track's default min-width:auto refuses to shrink below its content,
     which would push the strip past the measure on a long modified stamp. */
  min-width: 0;
}
.cell:last-child {
  border-right: none;
}

dt {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}
dd {
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.num {
  font-variant-numeric: tabular-nums;
}
</style>
