<script lang="ts">
// The micro layer: Departure Mono on its 11px pixel grid, wide tracking,
// uppercase. Uppercase is chrome only — note titles stay sentence case (§02).
let { label, meta = '' }: { label: string; meta?: string } = $props()
</script>

<div class="pane-label">
  <span>{label}</span>
  {#if meta}<span class="meta">{meta}</span>{/if}
</div>

<style>
.pane-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: var(--s2) var(--pane-x) var(--pane-y);
  border-bottom: var(--hairline) solid var(--line);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  font-weight: 400;
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
}
.meta {
  color: var(--dim);
}
</style>
