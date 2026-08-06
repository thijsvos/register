<script lang="ts">
import { search } from '../core/search'
import { settings } from '../core/settings.svelte'
import { vault } from '../core/store.svelte'
import { render } from '../lib/render.svelte'
import Editor from './Editor.svelte'
import Crosses from './Frame/Crosses.svelte'
import Header from './Frame/Header.svelte'
import Inspector from './Frame/Inspector.svelte'
import Sidebar from './Frame/Sidebar.svelte'
import StatusBar from './Frame/StatusBar.svelte'
import { installKeymap } from './keymap'
import Palette from './Palette/Palette.svelte'
import Settings from './Settings.svelte'
import Today from './Today.svelte'
import { chrome } from './view.svelte'

let crumb = $derived(
  chrome.settings
    ? 'CONFIG / SETTINGS'
    : chrome.today
      ? 'AGGREGATE / TODAY'
      : vault.active
        ? `INDEX / ${vault.active.ref ?? '—'} / ${vault.active.title ?? vault.active.path}`
        : 'INDEX',
)

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
$effect(() => {
  void settings.scheme
  chrome.applyScheme()
})
$effect(() => chrome.followOsScheme())
$effect(() => installKeymap())

// The editor chunk is fetched as soon as the frame is up, rather than when the
// first note is clicked.
//
// It stays a separate chunk and still does not block first paint, which is what
// §04's "lazy chunk" is for — but "lazy" was costing the *first* open 320 kB of
// CodeMirror to download and parse before anything was editable, and that click
// is the one every session begins with. Measured at 460–510 ms against §06's
// 500 ms on a developer machine and 1222 ms on a two-core runner.
//
// The import is idempotent: the click awaits the same promise this started, so
// warming overlaps the tree and corpus fetches instead of following them.
$effect(() => {
  const warm = () => {
    void import('../editor')
  }
  // After the frame, not during it. Idle if the browser offers it; a timeout
  // otherwise, because Safari only grew requestIdleCallback recently.
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(warm, { timeout: 1000 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(warm, 0)
  return () => clearTimeout(id)
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
      {:else if vault.openPath === null}
        <p class="empty">
          {vault.files === 0
            ? 'No notes yet. [N] creates the first one. ⌘K opens the console.'
            : 'No note open. Choose one from the index, or press ⌘K.'}
        </p>
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
    watcherLive={vault.connected}
    vault={vault.vaultPath}
    files={vault.files}
    words={vault.openWords}
    notice={vault.notice}
    dirty={vault.dirty}
    externalEdit={vault.externalEdit}
  />
</div>

{#if chrome.paletteOpen}
  <Palette />
{/if}

<style>
.app {
  display: grid;
  grid-template-rows: var(--frame-header) minmax(0, 1fr) var(--frame-foot);
  /* dvh, not vh: on mobile Safari 100vh exceeds the visual viewport and pushes
     the status bar under the browser chrome, which html{overflow:hidden} then
     makes unreachable. */
  height: 100dvh;
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
  max-width: var(--measure);
  margin: 0 auto;
  padding: var(--s6) var(--s5);
  font-size: var(--text-body);
  color: var(--dim);
}

@media (max-width: 1080px) {
  .mid,
  .app.no-index .mid {
    grid-template-columns: var(--frame-side) minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .mid,
  .app.no-index .mid,
  .app.no-inspector .mid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
