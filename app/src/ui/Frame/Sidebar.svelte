<script lang="ts">
import PaneEmpty from './PaneEmpty.svelte'
import PaneLabel from './PaneLabel.svelte'

// P1 ships the frame only; the vault reader arrives in P2/P3. Until then the
// counts are null, not zero — the app does not know there are no notes, it
// knows nothing, and §02b forbids chrome that states what it cannot derive.
// Null renders as the same em-dash the status bar already uses.
let {
  noteCount = null,
  tagCount = null,
}: {
  noteCount?: number | null
  tagCount?: number | null
} = $props()

const dash = '—'
</script>

<aside class="side" aria-label="Index">
  <PaneLabel label="Index" meta="[{noteCount ?? dash}]" />
  <PaneEmpty text={noteCount === null ? 'Index not loaded.' : 'No notes.'} />

  <PaneLabel label="Tags" meta="[{tagCount ?? dash}]" />
  <PaneEmpty text={tagCount === null ? 'Tags not loaded.' : 'No tags.'} />
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

/* Below 760px the frame collapses to a single column. The index returns as a
   toggled drawer with the IDX key in P5, when there is a keymap to hang it on. */
@media (max-width: 760px) {
  .side { display: none; }
}
</style>
