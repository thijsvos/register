<script lang="ts">
import { vault } from '../../core/store.svelte'
import PaneEmpty from './PaneEmpty.svelte'
import PaneLabel from './PaneLabel.svelte'

// Distinct tags, so the pane states what the vault actually holds. Counts and
// meters are P6; claiming "no tags" while notes carry them would not be.
let tags = $derived([...new Set(vault.tree.flatMap((entry) => entry.tags))].sort())

/** §02b nav row: arrow or j/k traversal, without a global keymap (that is P5). */
function traverse(event: KeyboardEvent) {
  const forward = event.key === 'ArrowDown' || event.key === 'j'
  const back = event.key === 'ArrowUp' || event.key === 'k'
  if (!forward && !back) return

  const sibling = forward
    ? event.currentTarget instanceof HTMLElement && event.currentTarget.nextElementSibling
    : event.currentTarget instanceof HTMLElement &&
      event.currentTarget.previousElementSibling
  if (sibling instanceof HTMLElement) {
    event.preventDefault()
    sibling.focus()
  }
}
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
          onclick={() => vault.open(entry.path)}
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
      {#each tags as tag (tag)}
        <li>#{tag}</li>
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

/* Below 760px the frame collapses to a single column. The index returns as a
   toggled drawer with the IDX key in P5, when there is a keymap to hang it on. */
@media (max-width: 760px) {
  .side {
    display: none;
  }
}
</style>
