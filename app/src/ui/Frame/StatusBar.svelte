<script lang="ts">
// §02b: "Chrome shows only derivable truth. No gauge may display a number the
// system cannot measure." Watcher, render and files are measured. Vault and git
// are not: §04's API table is complete and exposes neither, so they stay dashed
// rather than inventing a value.
let {
  renderMs = null,
  watcherLive = false,
  vault = null,
  files = null,
  git = null,
  notice = null,
  dirty = false,
}: {
  renderMs?: number | null
  watcherLive?: boolean
  vault?: string | null
  files?: number | null
  git?: string | null
  notice?: string | null
  dirty?: boolean
} = $props()

const dash = '—'
</script>

<footer>
  <div class="cell">
    <span class="led" class:live={watcherLive} aria-hidden="true">●</span>
    <span class="lab">Watcher</span> <b>{watcherLive ? 'Live' : dash}</b>
  </div>
  <div class="cell"><span class="lab">Vault</span> <b>{vault ?? dash}</b></div>
  <div class="cell">
    <span class="lab">Render</span>
    <b>{renderMs === null ? dash : `${renderMs.toFixed(2)}ms`}</b>
  </div>
  <div class="cell grow" role="status">
    {#if notice}
      <b class="notice">{notice}</b>
    {:else if dirty}
      <span class="lab">Saving</span>
    {/if}
  </div>
  <div class="cell"><b>{files ?? dash}</b> <span class="lab">files</span></div>
  <div class="cell"><span class="lab">Git</span> <b>{git ?? dash}</b></div>
</footer>

<style>
footer {
  display: flex;
  align-items: center;
  border-top: var(--hairline) solid var(--line);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
}
.cell {
  display: flex;
  align-items: center;
  gap: var(--s2);
  height: 100%;
  padding: 0 var(--s3);
  border-right: var(--hairline) solid var(--line);
}
.cell.grow {
  flex: 1;
  justify-content: flex-end;
  min-width: 0;
  border-right: none;
  border-left: var(--hairline) solid var(--line);
  margin-left: calc(-1 * var(--hairline));
}
.notice {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Label demoted, readout in full ink — otherwise the bar is a flat wall of
   identical micro type with no hierarchy between a field and its value. */
.lab {
  color: var(--dim);
}
b {
  font-weight: 400;
}

/* The status LED is the only animation permitted anywhere in the product, and
   it only runs when there is genuinely something live to report. */
.led {
  color: var(--faint);
}
.led.live {
  color: var(--signal);
  animation: pip 2.4s steps(2, jump-none) infinite;
}
@keyframes pip {
  50% {
    opacity: 0.2;
  }
}
@media (prefers-reduced-motion: reduce) {
  .led.live {
    animation: none;
  }
}
</style>
