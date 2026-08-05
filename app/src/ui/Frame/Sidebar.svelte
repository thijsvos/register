<script lang="ts">
import { vault } from '../../core/store.svelte'
import { tagCounts } from '../../core/tags'
import { go, traverse } from '../nav'
import PaneEmpty from './PaneEmpty.svelte'
import PaneLabel from './PaneLabel.svelte'

let tags = $derived(tagCounts(vault.tree))
// The meter is relative to the commonest tag, not to the note count: a vault
// where nothing is tagged twice should read as a flat row of equals, not as
// twenty bars all one pixel wide.
let busiest = $derived(Math.max(1, ...tags.map((tag) => tag.count)))
</script>

<aside class="side" aria-label="Index">
  <PaneLabel label="Index" meta="[{vault.files}]" />

  {#if vault.tree.length === 0}
    <PaneEmpty text="No notes. [N] creates the first one." />
  {:else}
    <nav>
      {#each vault.tree as entry (entry.path)}
        {@const words = vault.words(entry.path)}
        <button
          class="row"
          class:active={entry.path === vault.openPath}
          aria-current={entry.path === vault.openPath ? 'page' : undefined}
          onclick={() => go.note(entry.path)}
          onkeydown={traverse}
        >
          <span class="ref">{entry.ref ?? '—'}</span>
          <span class="name">{entry.title ?? entry.path}</span>
          <span class="count">{words ?? '—'}</span>
        </button>
      {/each}
    </nav>
  {/if}

  <PaneLabel label="Tags" meta="[{tags.length}]" />
  {#if tags.length === 0}
    <PaneEmpty text="No tags." />
  {:else}
    <ul class="tags">
      {#each tags as tag (tag.name)}
        <li>
          <span class="tag">#{tag.name}</span>
          <!-- Decorative: the number beside it is the content (§02, --faint). -->
          <span class="meter" aria-hidden="true">
            <i style:width="{(tag.count / busiest) * 100}%"></i>
          </span>
          <span class="count">{tag.count}</span>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
.side {
  border-right: var(--hairline) solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg);
}

nav {
  border-bottom: var(--hairline) solid var(--line);
}

/* §02b state matrix, Nav row: fg on bg with a dim ref · --hover wash · full
   inverse video when active · inset dashed ring on keyboard focus. */
.row {
  display: grid;
  grid-template-columns: var(--nav-ref) 1fr auto;
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
.row.active,
.row.active:hover {
  background: var(--sel-bg);
  color: var(--sel-fg);
}

.ref {
  color: var(--dim);
  font-size: var(--text-ui);
  font-variant-numeric: tabular-nums;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.count {
  color: var(--dim);
  font-size: var(--text-ui);
  font-variant-numeric: tabular-nums;
}
.row.active .ref,
.row.active .count {
  color: var(--sel-fg);
}

.tags {
  list-style: none;
  border-bottom: var(--hairline) solid var(--line);
  padding: var(--pane-y) var(--pane-x) var(--s2);
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  color: var(--dim);
}
.tags li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--meter-w) auto;
  gap: var(--s2);
  align-items: center;
  padding: var(--s1) 0;
}
.tag {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  font-variant-numeric: tabular-nums;
}

/* §02: --faint is decorative only — crosses, meters, rules. A meter is the one
   place it is allowed to carry a value, and the count beside it is the content
   for anyone who cannot resolve six pixels of grey. */
.meter {
  height: var(--meter-h);
  border: var(--hairline) solid var(--faint);
}
.meter i {
  display: block;
  height: 100%;
  background: var(--faint);
}

/* Below 760px the frame collapses to a single column. The index returns as a
   toggled drawer with the IDX key in P5, when there is a keymap to hang it on. */
@media (max-width: 760px) {
  .side {
    display: none;
  }
}
</style>
