<script lang="ts">
import { untrack } from 'svelte'
import { gitLabel } from '../core/git'
import { payload } from '../core/offline'
import { basename, folders } from '../core/paths'
import { search } from '../core/search'
import { settings } from '../core/settings.svelte'
import { vault } from '../core/store.svelte'
import { render } from '../lib/render.svelte'
import Attachments from './Attachments.svelte'
import Conflict from './Conflict.svelte'
import Editor from './Editor.svelte'
import Crosses from './Frame/Crosses.svelte'
import Header from './Frame/Header.svelte'
import Inspector from './Frame/Inspector.svelte'
import Sidebar from './Frame/Sidebar.svelte'
import StatusBar from './Frame/StatusBar.svelte'
import History from './History.svelte'
import { installKeymap } from './keymap'
import Media from './Media.svelte'
import { go } from './nav'
import Palette from './Palette/Palette.svelte'
import Settings from './Settings.svelte'
import Today from './Today.svelte'
import Trash from './Trash.svelte'
import { chrome } from './view.svelte'

/**
 * §02b Screen 1's GIT field (§08 P12), in git's own shorthand — see
 * `core/git.ts` for the marks and why they replaced CLEAN/DIRTY.
 *
 * `—` when the vault is not a repository, which is most of them.
 */
let gitField = $derived(gitLabel(vault.git))

/**
 * The export's stamp for the status bar (§12), or null on a served page.
 *
 * `2026-09-05 11:32Z` — the chrome's own form for a time, UTC to the minute,
 * cut from the ISO the binary wrote. Not the vault's mtime and not "today": it
 * is the moment this file was made, which is the only date it can be sure of.
 */
let exportStamp = $derived(
  payload === null ? null : `${payload.stamp.slice(0, 16).replace('T', ' ')}Z`,
)

/** Newest first, so the status bar's route lands on the one that just happened. */
let unresolved = $derived(vault.unresolved)

// Segments rather than one string, so the header can decide what to drop when
// there is not room: the folders shrink and the note's own identity does not.
// Uppercased by CSS, as chrome is throughout (§02).
let crumb = $derived.by(() => {
  if (chrome.settings) return ['Config', 'Settings']
  if (chrome.today) return ['Aggregate', 'Today']
  if (chrome.trash) return ['Recoverable', 'Trash']
  if (chrome.attachments) return ['Derived', 'Attachments']
  if (chrome.history !== null) {
    const about = chrome.history.path
    return about === null
      ? ['History', 'Ledger']
      : ['History', ...folders(about), basename(about)]
  }
  if (chrome.conflict !== null) return ['Conflict', 'Unresolved']
  // The file's own trail, so the crumb answers where it is exactly as it does
  // for a note — `MEDIA / NOTES / DIAGRAM.PNG`.
  if (chrome.media !== null) {
    return ['Media', ...folders(chrome.media), basename(chrome.media)]
  }
  const open = vault.active
  if (open === null) return ['Index']
  // The full folder trail, so the crumb answers where the file is and not only
  // which one it is — the index draws that structure now, and a breadcrumb that
  // disagreed with the tree beside it would be worse than one that said nothing.
  return [
    'Index',
    ...folders(open.path),
    open.ref ?? '—',
    open.title ?? basename(open.path),
  ]
})

$effect(() => {
  void vault.start()
  return () => vault.stop()
})

// The vault's own config, read once at boot: the stored scheme, the body face,
// and the licensed face registered under TX-02 (§02b Screen 6, §03).
$effect(() => {
  void settings.start()
})
// Re-applied whenever the stored scheme moves, including the moment it arrives.
//
// `untrack` because `applyScheme` reads `chrome.dark`, and a `$effect` tracks
// every reactive read inside it — including ones inside the functions it calls.
// Without it this effect depended on `chrome.dark` as well as on the setting, so
// INV set `dark`, the effect woke, and `applyScheme` put it straight back to the
// stored scheme. The button and the `i` key both looked dead.
//
// The dependency that is wanted is read explicitly above.
$effect(() => {
  void settings.scheme
  untrack(() => chrome.applyScheme())
})
$effect(() => chrome.followOsScheme())
$effect(() => installKeymap())

// The editor chunk is fetched as soon as the frame is up, rather than when the
// first note is clicked.
//
// It stays a separate chunk and still does not block first paint, which is what
// §04's "lazy chunk" is for — but "lazy" was costing the *first* open 320 kB of
// CodeMirror to download and parse before anything was editable, and that click
// is the one every session begins with.
//
// Started immediately rather than on an idle callback. Idle was the tidier
// instinct and it was wrong: on a two-core runner boot leaves no idle before
// the first click, so the warm never happened where it was needed most — 1222
// ms with the idle version, unchanged from having no warm at all. This effect
// already runs after the DOM is updated, so the fetch overlaps the tree and the
// corpus instead of following a click, and the import is idempotent: the click
// awaits the same promise this started.
$effect(() => {
  void import('../editor')
})

// The search index is kept warm from boot rather than built when ⌘K first opens.
// P5 budgets the palette at 16 ms to open; indexing a 1k-note vault is two orders
// of magnitude past that, so it is paid one arriving body at a time instead —
// each corpus fetch costs a single incremental add.
$effect(() => {
  search.sync(vault.tree, vault.corpus)
})
</script>

<Crosses />

<div class="app" class:no-index={!chrome.index} class:no-inspector={!chrome.inspector}>
  <Header {crumb} pressed={chrome.inverted} oninvert={() => chrome.invert()}
    onpalette={() => chrome.openPalette()}
  />
  <div class="mid">
    {#if chrome.index}
      <Sidebar />
    {/if}
    <main>
      {#if chrome.settings}
        <Settings />
      {:else if chrome.today}
        <Today />
      {:else if chrome.trash}
        <Trash />
      {:else if chrome.attachments}
        <Attachments />
      {:else if chrome.history !== null}
        <History path={chrome.history.path} />
      {:else if chrome.conflict !== null}
        <Conflict copy={chrome.conflict} />
      {:else if chrome.media !== null}
        <Media path={chrome.media} />
      {:else if vault.openPath === null}
        {#if vault.files === 0}
          <!-- §02b Screen 3, in full. The last sentence is the one the frame is
               for: an empty vault is not a failure to have written anything, it
               is the folder an agent writes into while you watch. Saying only
               the first two lines described the keys and never the product. -->
          <div class="empty">
            <p>No notes yet.</p>
            <p>[N] creates the first one. ⌘K opens the console.</p>
            <p>
              Point Claude Code at this folder and it writes straight to disk —
              you will watch the note appear.
            </p>
          </div>
        {:else}
          <p class="empty">No note open. Choose one from the index, or press ⌘K.</p>
        {/if}
      {:else}
        <Editor />
      {/if}
    </main>
    {#if chrome.inspector}
      <Inspector />
    {/if}
  </div>
  <StatusBar
    renderMs={render.ms}
    watcherDelta={render.delta}
    watcherLive={vault.connected}
    vault={vault.vaultPath}
    files={vault.files}
    words={vault.openWords}
    chars={vault.openChars}
    git={gitField}
    notice={vault.notice}
    dirty={vault.dirty}
    externalEdit={vault.externalEdit}
    unresolved={unresolved.length}
    onresolve={() => go.newestConflict()}
    outside={vault.outside.length}
    onoutside={() => go.ledger()}
    {exportStamp}
  />
</div>

{#if chrome.paletteOpen}
  <Palette />
{/if}

<style>
.app {
  display: grid;
  grid-template-rows: var(--frame-header) minmax(0, 1fr) var(--frame-foot);
  /* The column, declared, for the same reason `.mid` declares its own: an
     implicit `auto` track sizes to its contents, and the header and the status
     bar are both `white-space: nowrap` rows whose min-content runs past any
     narrow viewport — measured at 1095px and 1728px against an 800px window.
     Every row then stretched to the widest of them, so the frame drew 1080px
     wide inside 800px of screen with the clock, INV and ⌘K off the right edge —
     and `html { overflow: hidden }` meant no scrollbar could reach them.
     `minmax(0, 1fr)` lets the track shrink to the frame, and each row clips
     inside its own `overflow: hidden` instead of pushing the frame out. */
  grid-template-columns: minmax(0, 1fr);
  /* dvh, not vh: on mobile Safari 100vh exceeds the visual viewport and pushes
     the status bar under the browser chrome, which html{overflow:hidden} then
     makes unreachable.
     Divided by the plate scale for the same reason: viewport units resolve
     against the unzoomed viewport, so an undivided 100dvh at 2x makes .app
     twice the viewport tall — measured, that puts the status bar off-screen
     behind the same overflow:hidden, with no scrollbar to reach it. */
  height: calc(100dvh / var(--ui-scale));
  /* The breakpoints below ask the frame how wide it is in plate units. A media
     query would answer with the raw viewport, which at 2x is twice the room the
     frame actually has. */
  container-type: inline-size;
  container-name: frame;
}
.mid {
  display: grid;
  grid-template-columns: var(--frame-side) minmax(0, 1fr) var(--frame-insp);
  min-height: 0;
}
.app.no-index .mid {
  grid-template-columns: minmax(0, 1fr) var(--frame-insp);
}
.app.no-inspector .mid {
  grid-template-columns: var(--frame-side) minmax(0, 1fr);
}
.app.no-index.no-inspector .mid {
  grid-template-columns: minmax(0, 1fr);
}
main {
  overflow-y: auto;
  min-height: 0;
}
.empty {
  max-width: var(--measure-box);
  margin: 0 auto;
  padding: var(--s6) var(--s5);
  font-size: var(--text-body);
  color: var(--dim);
}
/* One line per sentence, as Screen 3 draws them. A single paragraph would wrap
   the keys into the prose and lose the shape the frame is making. */
.empty p + p {
  margin-top: var(--s2);
}

@container frame (max-width: 1080px) {
  .mid,
  .app.no-index .mid {
    grid-template-columns: var(--frame-side) minmax(0, 1fr);
  }
}
@container frame (max-width: 760px) {
  .mid,
  .app.no-index .mid,
  .app.no-inspector .mid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
