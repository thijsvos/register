<script lang="ts">
import { basename, dailyDate, isConflictCopy, isIndexed } from '../../core/paths'
import { settings } from '../../core/settings.svelte'
import { vault } from '../../core/store.svelte'
import { tagCounts } from '../../core/tags'
import { ancestors, folderTree, type Node } from '../../core/tree'
import { go, treeTraverse } from '../nav'
import { chrome } from '../view.svelte'
import PaneEmpty from './PaneEmpty.svelte'
import PaneLabel from './PaneLabel.svelte'

// Your notes and your journal. `CLAUDE.md` is the agent's brief and
// `templates/` are stencils: both stay out, still reachable through ⌘K, and a
// stencil is also a row under NEW FROM TEMPLATE.
//
// The journal is in now. It was hidden because there is one log per day
// forever and `daily/` sorts before `notes/`, so a year of dated rows would sit
// above everything you wrote — true of a flat list, and no longer true of a
// folder that starts shut. It costs one row, newest first, and it is the only
// way to reach a day you did not write a link to.
let notes = $derived(vault.tree.filter((entry) => isIndexed(entry.path)))
let tree = $derived(folderTree(notes))

// The open note is always visible, whatever is folded shut. Computed here
// rather than by un-collapsing on open, so what is stored stays what the reader
// chose instead of drifting every time ⌘K lands inside a folded folder.
let revealed = $derived(new Set(vault.openPath === null ? [] : ancestors(vault.openPath)))
const shown = (folder: string) => settings.isOpen(folder) || revealed.has(folder)
let tags = $derived(tagCounts(vault.tree))
// The meter is relative to the commonest tag, not to the note count: a vault
// where nothing is tagged twice should read as a flat row of equals, not as
// twenty bars all one pixel wide.
let busiest = $derived(Math.max(1, ...tags.map((tag) => tag.count)))

/**
 * `MON`…`SUN` for a `YYYY-MM-DD`.
 *
 * UTC, like every other date the chrome shows — reading it in local time would
 * name the wrong day for anyone west of Greenwich, on the one row whose entire
 * job is saying which day it is.
 */
function weekday(date: string): string {
  return new Date(`${date}T00:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
    .toUpperCase()
}
</script>

<aside class="side" aria-label="Index">
  <PaneLabel label="Index" meta="[{vault.files}]" />

  {#if notes.length === 0}
    <PaneEmpty text="No notes. [N] creates the first one." />
  {:else}
    <nav>
      {@render rows(tree, 0)}
    </nav>
  {/if}

  <PaneLabel label="Tags" meta="[{tags.length}]" />
  {#if tags.length === 0}
    <PaneEmpty text="No tags." />
  {:else}
    <ul class="tags">
      {#each tags as tag (tag.name)}
        <li>
          <!-- The palette rather than a filter: §02b defines no tag component,
               so a click hands the question to the surface that already answers
               it, with the states it already draws. -->
          <button class="tag" onclick={() => chrome.openPalette(`tag:${tag.name}`)}>
            #{tag.name}
          </button>
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

<!--
  One snippet, recursing on itself, because a tree is one. Depth is passed
  rather than measured so the indent is arithmetic on a token instead of a
  nested box model: a 250px rail cannot afford a margin per level.
-->
{#snippet rows(nodes: Node[], depth: number)}
  {#each nodes as node (node.path)}
    {#if node.kind === 'folder'}
      {@const open = shown(node.path)}
      <button
        class="row folder"
        aria-expanded={open}
        data-depth={depth}
        data-kind="folder"
        data-path={node.path}
        style:padding-left="calc(var(--pane-x) + {depth} * var(--s3))"
        onclick={() => settings.toggleFolder(node.path)}
        onkeydown={treeTraverse}
      >
        <!-- Decorative: the row's own aria-expanded is what a screen reader
             reads, so the arrow must not be announced twice. -->
        <span class="twist" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span class="name">{node.label}</span>
        <span class="count">{node.count}</span>
      </button>
      {#if open}
        {@render rows(node.children, depth + 1)}
      {/if}
    {:else}
      {@const entry = node.entry}
      {@const words = vault.words(entry.path)}
      {@const artefact = isConflictCopy(entry.path)}
      {@const day = dailyDate(entry.path)}
      <!-- §04: a conflict copy is "an artefact to merge, not a note". It
           carries the original's ref and title verbatim, so drawn as a note it
           is indistinguishable from the note it came from — which is how one
           sat in this list announced by nothing. It reads as what it is, and
           it opens §02b Screen 4 rather than the editor. -->
      <button
        class="row"
        class:active={entry.path === vault.openPath}
        aria-current={entry.path === vault.openPath ? 'page' : undefined}
        title={artefact ? entry.path : undefined}
        data-depth={depth}
        data-path={entry.path}
        style:padding-left="calc(var(--pane-x) + {depth} * var(--s3))"
        onclick={() => (artefact ? go.conflict(entry.path) : go.note(entry.path))}
        onkeydown={treeTraverse}
      >
        <!-- A daily log has no ref — §04 gives it a date instead of a number — so
             the column that would carry one carries the weekday, which is what
             makes a list of dates scannable. The date itself comes from the
             filename rather than the title: the filename is what §04 fixes, and
             a log written by an older build can be titled anything at all. -->
        <span class="ref">{day === null ? (artefact ? '—' : (entry.ref ?? '—')) : weekday(day)}</span>
        <span class="name"
          >{day ?? (artefact ? basename(entry.path) : (entry.title ?? entry.path))}</span
        >
        {#if artefact}
          <span class="unresolved">Unresolved</span>
        {:else}
          <span class="count">{words ?? '—'}</span>
        {/if}
      </button>
    {/if}
  {/each}
{/snippet}

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

/* A folder is a nav row like any other — same hover, same focus ring, same
   inverse when it is the one you are on — but it has no ref, so the twist
   occupies that column and keeps every title on the same vertical line.
   Left-aligned, not centred: the ref beside it is, and a twist floating in the
   middle of its column put every folder's left edge out of register with the
   notes underneath it — visible as a jagged margin down the whole pane, in a
   product named after registration marks. */
.folder .twist {
  color: var(--dim);
  font-size: var(--text-ui);
}
.folder .name {
  text-transform: uppercase;
  letter-spacing: var(--track-ui);
  font-size: var(--text-ui);
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

/* The one word that separates an artefact from a note, in the field the word
   count would otherwise occupy — a copy has no reading length worth reporting. */
.unresolved {
  color: var(--signal);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
}
.row.active .unresolved {
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
/* A button, so the UA stylesheet is reset back to the row it lives in: font,
   colour and background are all inherited from the pane rather than taken from
   the browser's control defaults. Learned the hard way — a control that lost
   its `text-transform` this way read as a different component. */
.tag {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  border: 0;
  padding: 0;
  background: none;
  font: inherit;
  letter-spacing: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.tag:hover {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.tag:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
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
@container frame (max-width: 760px) {
  .side {
    display: none;
  }
}
</style>
