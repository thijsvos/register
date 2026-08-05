<script lang="ts">
import { measure, render } from '../lib/render.svelte'
import Crosses from './Frame/Crosses.svelte'
import Header from './Frame/Header.svelte'
import Inspector from './Frame/Inspector.svelte'
import Sidebar from './Frame/Sidebar.svelte'
import StatusBar from './Frame/StatusBar.svelte'

const osScheme = matchMedia('(prefers-color-scheme: dark)')

// The boot script in index.html already applied the OS scheme before first
// paint; read it back rather than asking the media query again, so INV toggles
// from whatever is actually on screen.
let dark = $state(document.documentElement.classList.contains('dark'))

// INV means "inverted from the OS", not "dark is on" — otherwise a user whose
// OS is dark boots with the key already lit for a state they never entered.
let inverted = $derived(dark !== osScheme.matches)

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

function invert() {
  measure(() => {
    dark = !dark
    document.documentElement.classList.toggle('dark', dark)
  })
}
</script>

<Crosses />

<div class="app">
  <Header pressed={inverted} oninvert={invert} />
  <div class="mid">
    <Sidebar />
    <main></main>
    <Inspector />
  </div>
  <StatusBar renderMs={render.ms} />
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

@media (max-width: 1080px) {
  .mid { grid-template-columns: var(--frame-side) minmax(0, 1fr); }
}
@media (max-width: 760px) {
  .mid { grid-template-columns: minmax(0, 1fr); }
}
</style>
