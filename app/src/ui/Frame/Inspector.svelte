<script lang="ts">
import { rawFields } from '../../core/frontmatter'
import { links } from '../../core/links'
import { outline } from '../../core/outline'
import { tagsOf } from '../../core/refs'
import { vault } from '../../core/store.svelte'
import { countsFor } from '../../core/tags'
import { go, traverse } from '../nav'
import { chrome } from '../view.svelte'
import PaneEmpty from './PaneEmpty.svelte'
import PaneLabel from './PaneLabel.svelte'

// Every pane here is derived data (§02b Screen 1: "all derived"). With no note
// open there is nothing to derive from, so the counts read — rather than assert
// a zero the app has no way to know.
const dash = '—'

let open = $derived(vault.openPath !== null)

// From the buffer, not the corpus: a heading appears in the outline as it is
// typed, and a property changes as it is edited. The corpus is a save behind.
//
// Raw rather than unquoted, because this pane is now where §04's frontmatter is
// edited — the editor hides it. A field shown as `Costs: a study` and written
// back as typed would drop the quotes it needs and leave a line whose colon
// reads as a second mapping. What you see is the line.
let properties = $derived(open ? [...rawFields(vault.buffer)] : [])

/**
 * The two §04 fields this pane shows and will not change.
 *
 * "id: ULID, never changes" and "ref: zero-padded, immutable" — and a `[[NNN]]`
 * link resolves by ref, so editing one would re-point every link to the note.
 * `vault.setNoteField` refuses them too; this is only what draws them locked.
 */
const IMMUTABLE = new Set(['id', 'ref'])

/**
 * Commit on Enter, abandon on Escape.
 *
 * Blur commits as well — a field left edited and clicked away from has been
 * edited, and the alternative is a pane that silently discards what you typed.
 */
function commit(key: string, input: HTMLInputElement): void {
  vault.setNoteField(key, input.value)
}

function keys(event: KeyboardEvent, key: string): void {
  const input = event.currentTarget as HTMLInputElement
  if (event.key === 'Enter') {
    event.preventDefault()
    commit(key, input)
    input.blur()
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    // Back to what the buffer holds, which is the file. Nothing to undo.
    input.value = rawFields(vault.buffer).get(key) ?? ''
    input.blur()
  }
}
let headings = $derived(open ? outline(vault.buffer) : [])
let tags = $derived(open ? countsFor(vault.tree, tagsOf(vault.buffer)) : [])

// The graph, by contrast, is a property of the vault rather than of the buffer,
// so it syncs from the corpus. Calling sync here is what makes this reactive:
// it reads the tree and the corpus, so the derived re-runs when either moves.
let backlinks = $derived.by(() => {
  links.sync(vault.tree, vault.corpus)
  const path = vault.openPath
  return path === null ? [] : links.backlinks(path)
})

/** `[3]` when a note is open, `[—]` when there is nothing to have counted. */
function meta(count: number): string {
  return open ? `[${count}]` : `[${dash}]`
}
</script>

<aside class="insp" aria-label="Inspector">
  <PaneLabel label="Properties" />
  {#if properties.length === 0}
    <PaneEmpty text={open ? 'No frontmatter.' : 'No note open.'} />
  {:else}
    <dl class="props">
      {#each properties as [key, value] (key)}
        <dt>{key}</dt>
        {#if IMMUTABLE.has(key)}
          <dd class="fixed" title={value}>{value || dash}</dd>
        {:else}
          <dd>
            <!-- §02b Input: "signal caret ›, no box — caret only; the label is
                 the frame". The key in the column beside it is that label, so
                 the control needs no border and gets none. -->
            <input
              class="edit"
              type="text"
              value={value}
              aria-label={key}
              spellcheck="false"
              autocomplete="off"
              onkeydown={(event) => keys(event, key)}
              onblur={(event) => commit(key, event.currentTarget)}
            />
          </dd>
        {/if}
      {/each}
    </dl>
  {/if}

  <PaneLabel label="Outline" meta={meta(headings.length)} />
  {#if headings.length === 0}
    <PaneEmpty text={open ? 'No headings.' : 'No note open.'} />
  {:else}
    <nav aria-label="Outline">
      {#each headings as heading (heading.from)}
        <button
          class="row head"
          style:padding-left="calc(var(--pane-x) + {heading.level - 1} * var(--s3))"
          onclick={() => chrome.reveal(heading.from)}
          onkeydown={traverse}
        >
          <span class="level">H{heading.level}</span>
          <span class="name">{heading.text}</span>
        </button>
      {/each}
    </nav>
  {/if}

  <PaneLabel label="Backlinks" meta={meta(backlinks.length)} />
  {#if backlinks.length === 0}
    <PaneEmpty text={open ? 'No backlinks.' : 'No note open.'} />
  {:else}
    <nav aria-label="Backlinks">
      {#each backlinks as entry (entry.path)}
        <button class="row" onclick={() => go.note(entry.path)} onkeydown={traverse}>
          <span class="ref">{entry.ref ?? dash}</span>
          <span class="name">{entry.title ?? entry.path}</span>
        </button>
      {/each}
    </nav>
  {/if}

  <PaneLabel label="Tags" meta={meta(tags.length)} />
  {#if tags.length === 0}
    <PaneEmpty text={open ? 'No tags.' : 'No note open.'} />
  {:else}
    <ul class="tags">
      {#each tags as tag (tag.name)}
        <li>
          <button class="name" onclick={() => chrome.openPalette(`tag:${tag.name}`)}>
            #{tag.name}
          </button><span class="count">{tag.count}</span>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
.insp {
  border-left: var(--hairline) solid var(--line);
  overflow-y: auto;
  min-height: 0;
}

/* The keys are the micro layer, so the whole grid takes Departure Mono's 17px
   leading — the inherited 1.6 body line-height computes to 17.6px and puts every
   micro baseline off-pixel on a face that is bitmap-derived (§02). */
.props {
  display: grid;
  grid-template-columns: var(--insp-key) minmax(0, 1fr);
  gap: var(--s1) var(--s2);
  padding: var(--pane-y) var(--pane-x) var(--s2);
  border-bottom: var(--hairline) solid var(--line);
  font-size: var(--text-ui);
  line-height: var(--lh-micro);
}
dt {
  font-family: var(--font-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}
/* Both columns clip. An agent may write any key it likes into frontmatter, and
   §04 says we round-trip it untouched — so the pane has to survive one that is
   longer than the column rather than push the value off the panel. */
dt,
dd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The editable value. §02b Input is "signal caret, no box" — so the box is the
   one thing this must not grow, and the field reads as text until the caret is
   in it. Sized from the row rather than from the browser's default input
   metrics, which are a different face at a different size. */
.edit {
  width: 100%;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  letter-spacing: inherit;
  color: inherit;
  caret-color: var(--signal);
}
.edit:focus {
  outline: none;
}
/* The dashed ring §02's a11y floor asks for, on the row rather than on the box,
   so the affordance appears where the value is without drawing an input. */
.edit:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
}
/* §04 calls id and ref immutable, so they are shown and never offered. Demoted
   to say so — the same ink the keys take, since neither is yours to change. */
.fixed {
  color: var(--dim);
}

nav {
  border-bottom: var(--hairline) solid var(--line);
}

/* §02b state matrix, Nav row: fg on bg with a dim ref · --hover wash · inset
   dashed ring on keyboard focus. Nothing here is ever "active": these rows
   navigate, they do not hold a selection. */
.row {
  display: grid;
  grid-template-columns: var(--nav-ref) minmax(0, 1fr);
  gap: var(--s2);
  align-items: baseline;
  width: 100%;
  padding: var(--pane-y) var(--pane-x);
  text-align: left;
  font-size: var(--text-body);
  white-space: nowrap;
}
.row:hover {
  background: var(--hover);
}
.row:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-inset);
}
/* The indent carries the level, so the column that names it can be narrow. */
.row.head {
  grid-template-columns: var(--insp-level) minmax(0, 1fr);
}

.ref,
.level,
.count {
  color: var(--dim);
  font-size: var(--text-ui);
  font-variant-numeric: tabular-nums;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tags {
  list-style: none;
  border-bottom: var(--hairline) solid var(--line);
  padding: var(--pane-y) var(--pane-x) var(--s2);
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
}
.tags li {
  display: flex;
  justify-content: space-between;
  gap: var(--s2);
  padding: var(--s1) 0;
}
/* Reset to the row, not to the browser's control defaults — see Sidebar. */
.tags .name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 0;
  padding: 0;
  background: none;
  font: inherit;
  letter-spacing: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.tags .name:hover {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.tags .name:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
}

@container frame (max-width: 1080px) {
  .insp { display: none; }
}
</style>
