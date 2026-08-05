<script lang="ts">
import { vault } from '../core/store.svelte'
import { measure, render } from '../lib/render.svelte'
import Editor from './Editor.svelte'
import Crosses from './Frame/Crosses.svelte'
import Header from './Frame/Header.svelte'
import Inspector from './Frame/Inspector.svelte'
import Sidebar from './Frame/Sidebar.svelte'
import StatusBar from './Frame/StatusBar.svelte'

const osScheme = matchMedia('(prefers-color-scheme: dark)')

// The boot script in index.html has already applied the OS scheme before first
// paint; read it back rather than asking the media query again, so INV toggles
// from whatever is actually on screen.
let dark = $state(document.documentElement.classList.contains('dark'))

// INV means "inverted from the OS", not "dark is on" — otherwise a user whose
// OS is dark boots with the key already lit for a state they never entered.
let inverted = $derived(dark !== osScheme.matches)

let crumb = $derived(
  vault.active
    ? `INDEX / ${vault.active.ref ?? '—'} / ${vault.active.title ?? vault.active.path}`
    : 'INDEX',
)

$effect(() => {
  void vault.start()
  return () => vault.stop()
})

// Rule 4 forbids storing a preference, so the OS is the only durable source of
// truth: when it changes, it wins and any INV inversion is dropped.
$effect(() => {
  const onSchemeChange = (event: MediaQueryListEvent) => {
    measure(() => {
      dark = event.matches
      document.documentElement.classList.toggle('dark', dark)
    })
  }
  osScheme.addEventListener('change', onSchemeChange)
  return () => osScheme.removeEventListener('change', onSchemeChange)
})

// The minimum needed to exercise §04's new-note flow, and to make §02b Screen
// 3's "[N] creates the first one" true rather than decorative. P5 replaces this
// with the real global keymap.
$effect(() => {
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'n' && event.key !== 'N') return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.matches('textarea, input, [contenteditable]')
    ) {
      return
    }
    event.preventDefault()
    void vault.create('Untitled note')
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
})

function invert() {
  measure(() => {
    dark = !dark
    document.documentElement.classList.toggle('dark', dark)
  })
}
</script>

<Crosses />

<div class="app">
  <Header {crumb} pressed={inverted} oninvert={invert} />
  <div class="mid">
    <Sidebar />
    <main>
      {#if vault.openPath === null}
        <p class="empty">
          {vault.files === 0
            ? 'No notes yet. [N] creates the first one.'
            : 'No note open. Choose one from the index.'}
        </p>
      {:else}
        <Editor />
      {/if}
    </main>
    <Inspector />
  </div>
  <StatusBar
    renderMs={render.ms}
    watcherLive={vault.connected}
    files={vault.files}
    notice={vault.notice}
    dirty={vault.dirty}
  />
</div>

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
  .mid {
    grid-template-columns: var(--frame-side) minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .mid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
