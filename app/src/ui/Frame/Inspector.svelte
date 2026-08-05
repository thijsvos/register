<script lang="ts">
import PaneEmpty from './PaneEmpty.svelte'
import PaneLabel from './PaneLabel.svelte'

// Every inspector pane is derived data (§02b Screen 1: "all derived"). With no
// note open there is nothing to derive from, so the counts stay null rather
// than asserting a zero the app has no way to know.
let { backlinkCount = null }: { backlinkCount?: number | null } = $props()

const dash = '—'
</script>

<aside class="insp" aria-label="Inspector">
  <PaneLabel label="Properties" />
  <PaneEmpty text="No note open." />

  <PaneLabel label="Outline" />
  <PaneEmpty text="No headings." />

  <PaneLabel label="Backlinks" meta="[{backlinkCount ?? dash}]" />
  <PaneEmpty text="No backlinks." />
</aside>

<style>
.insp {
  border-left: var(--hairline) solid var(--line);
  overflow-y: auto;
  min-height: 0;
}

@media (max-width: 1080px) {
  .insp { display: none; }
}
</style>
