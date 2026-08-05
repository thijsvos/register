<script lang="ts">
import { fields } from '../../core/frontmatter'
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
let properties = $derived(open ? [...fields(vault.buffer)] : [])
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
        <dd title={value}>{value || dash}</dd>
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
        <li><span class="name">#{tag.name}</span><span class="count">{tag.count}</span></li>
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

@media (max-width: 1080px) {
  .insp { display: none; }
}
</style>
