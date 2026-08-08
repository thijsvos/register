<script lang="ts">
import { untrack } from 'svelte'
import { search } from '../core/search'
import { settings } from '../core/settings.svelte'
import { vault } from '../core/store.svelte'
import { render } from '../lib/render.svelte'
import Conflict from './Conflict.svelte'
import Editor from './Editor.svelte'
import Crosses from './Frame/Crosses.svelte'
import Header from './Frame/Header.svelte'
import Inspector from './Frame/Inspector.svelte'
import Sidebar from './Frame/Sidebar.svelte'
import StatusBar from './Frame/StatusBar.svelte'
import { installKeymap } from './keymap'
import { go } from './nav'
import Palette from './Palette/Palette.svelte'
import Settings from './Settings.svelte'
import Today from './Today.svelte'
import { chrome } from './view.svelte'

/**
 * §02b Screen 1's GIT field, finally fillable (§08 P12).
 *
 * `—` when the vault is not a repository, which is most of them. "Chrome shows
 * only derivable truth" — so this says CLEAN only when git says clean, and
 * counts ahead only when there is an upstream to be ahead of.
 */
let gitLabel = $derived.by(() => {
  const state = vault.git
  if (state === null) return null
  if (state.ahead !== null && state.ahead > 0) return `${state.ahead} ahead`
  return state.clean ? 'Clean' : 'Dirty'
})

/** Newest first, so the status bar's route lands on the one that just happened. */
let unresolved = $derived(vault.unresolved)

function resolveNewest(): void {
  const first = unresolved[0]
  if (first !== undefined) go.conflict(first.copy.path)
}

let crumb = $derived(
  chrome.settings
    ? 'CONFIG / SETTINGS'
    : chrome.today
      ? 'AGGREGATE / TODAY'
      : chrome.conflict !== null
        ? 'CONFLICT / UNRESOLVED'
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
      {:else if chrome.conflict !== null}
        <Conflict copy={chrome.conflict} />
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
    git={gitLabel}
    notice={vault.notice}
    dirty={vault.dirty}
    externalEdit={vault.externalEdit}
    unresolved={unresolved.length}
    onresolve={resolveNewest}
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
