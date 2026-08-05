<script lang="ts">
import { search } from '../core/search'
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
import { chrome } from './view.svelte'

let crumb = $derived(
  vault.active
    ? `INDEX / ${vault.active.ref ?? '—'} / ${vault.active.title ?? vault.active.path}`
    : 'INDEX',
)

$effect(() => {
  void vault.start()
  return () => vault.stop()
})

$effect(() => chrome.followOsScheme())
$effect(() => installKeymap())

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
      {#if vault.openPath === null}
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
