<script lang="ts">
// §02b: "Chrome shows only derivable truth. No gauge may display a number the
// system cannot measure." Watcher, render, files, vault and git are all reported
// by the server. Git dashes when the server cannot see a repository, which now
// means one thing rather than two: the vault is not one. It used to also mean
// "nothing can answer" — the image was `FROM scratch` and had no git binary, so
// the field dashed in every container however the vault was stored. That was
// written down here and nowhere else for four days; `deploy/Dockerfile` carries
// git now, and `tests/release.rs` keeps it there. Still a measured absence
// rather than a missing feature.
let {
  renderMs = null,
  watcherLive = false,
  vault = null,
  files = null,
  git = null,
  notice = null,
  dirty = false,
  externalEdit = false,
  words = null,
  unresolved = 0,
  onresolve,
}: {
  renderMs?: number | null
  watcherLive?: boolean
  vault?: string | null
  files?: number | null
  git?: string | null
  notice?: string | null
  dirty?: boolean
  externalEdit?: boolean
  words?: number | null
  /** Unresolved `*.conflict-<ts>.md` copies in the vault (§02b Screen 4). */
  unresolved?: number
  onresolve?: () => void
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
    {#if externalEdit}
      <!-- Latched, and in the signal colour: the note moved under an unsaved
           buffer, and nothing else in the chrome carries that weight. -->
      <b class="alert">External edit</b>
    {:else if notice}
      <b class="notice">{notice}</b>
    {:else if dirty}
      <span class="lab">Saving</span>
    {/if}
  </div>
  {#if words !== null}
    <div class="cell"><b>{words}</b> <span class="lab">words</span></div>
  {/if}
  <div class="cell"><b>{files ?? dash}</b> <span class="lab">files</span></div>
  {#if unresolved > 0}
    <!-- Vault-wide and latched, so it sits with FILES and GIT rather than in the
         status cell above — that one is about the open note and is cleared by
         the next save, which is exactly how a conflict used to go unannounced. -->
    <div class="cell">
      <button class="resolve" onclick={() => onresolve?.()}>
        <b class="alert">{unresolved} unresolved</b>
      </button>
    </div>
  {/if}
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
  /* The bar clips at `overflow: hidden` above, and a flex item's default
     min-width:auto refuses to shrink — so in a narrow frame the rightmost cells
     were pushed past the edge whole rather than tightening: WORDS, FILES, GIT
     and the `N unresolved` button, which is the only route from the bar to
     conflict resolution, all silently gone with no scrollbar to reach them.
     This is reachable today at a narrow window; offering 2x makes a narrow
     PLATE reachable on a desktop, which is how it got here. */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
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
.alert {
  color: var(--signal);
}

/* Text that is a control, as TODAY's row jumps already are: no box in a 30px
   rail, but the state matrix's hover-inverse and dashed focus ring both hold. */
.resolve {
  font-variant-numeric: tabular-nums;
  text-transform: uppercase;
}
.resolve:hover {
  background: var(--sel-bg);
}
.resolve:hover .alert {
  color: var(--sel-fg);
}
.resolve:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
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
