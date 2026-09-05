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
  watcherDelta = null,
  watcherLive = false,
  vault = null,
  files = null,
  words = null,
  chars = null,
  git = null,
  notice = null,
  dirty = false,
  externalEdit = false,
  unresolved = 0,
  onresolve,
  outside = 0,
  onoutside,
  extract = null,
}: {
  renderMs?: number | null
  /**
   * Notes the vault gained or lost in the watcher burst that caused the last
   * render, or null when we caused it ourselves (§02b Screen 7).
   */
  watcherDelta?: number | null
  watcherLive?: boolean
  vault?: string | null
  files?: number | null
  /**
   * The open note's counts, live (§08 P4: "Words/chars + RENDER ms live").
   *
   * Here rather than in a strip above the note, where they were for a day: they
   * are instrument readouts about what is being written, and this is the rail
   * the other one lives in. §02b's own status line does not draw them, which
   * puts them where the `N unresolved` button already is — an addition the
   * frame does not draw, taken deliberately and written down.
   */
  words?: number | null
  chars?: number | null
  git?: string | null
  notice?: string | null
  dirty?: boolean
  externalEdit?: boolean
  /** Unresolved `*.conflict-<ts>.md` copies in the vault (§02b Screen 4). */
  unresolved?: number
  onresolve?: () => void
  /** Notes changed outside the app since the last save (§02b Screen 11). */
  outside?: number
  onoutside?: () => void
  /**
   * When this page is an extract (§12): the stamp the binary wrote it at.
   *
   * It takes the watcher's cell, because it answers the watcher's question —
   * how current is what you are reading — for a page nothing will ever update.
   * GIT goes with it: there is no repository behind an extract to report on,
   * and a dash there would claim a measurement nothing made.
   */
  extract?: string | null
} = $props()

const dash = '—'

/** `+1` / `-2`, the way §02b Screen 7 writes a delta. */
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

// §02b Screen 7 swaps this whole cell rather than adding one: idle reads
// `RENDER 0.70ms` and an agent write reads `WATCHER +1 4.1ms`. Both are the
// cost of the last repaint; the label says who asked for it.
let renderLabel = $derived(watcherDelta === null ? 'Render' : 'Watcher')
let renderValue = $derived.by(() => {
  if (renderMs === null) return dash
  const cost = `${renderMs.toFixed(2)}ms`
  return watcherDelta ? `${signed(watcherDelta)} ${cost}` : cost
})
</script>

<footer>
  {#if extract !== null}
    <div class="cell"><span class="lab">Extract</span> <b>{extract}</b></div>
  {:else}
    <div class="cell">
      <span class="led" class:live={watcherLive} aria-hidden="true">●</span>
      <span class="lab">Watcher</span> <b>{watcherLive ? 'Live' : dash}</b>
    </div>
  {/if}
  <div class="cell"><span class="lab">Vault</span> <b>{vault ?? dash}</b></div>
  {#if watcherDelta !== null && watcherDelta !== 0}
    <!-- §02b Screen 7 draws the delta twice — once alone and once inside the
         render cell — and it is the frame, so it is drawn twice. The bare one
         is the count moving; the one beside the timing says what the timing is
         of. Absent when the burst changed no count, which is an agent editing a
         note that was already there. -->
    <div class="cell"><b>{signed(watcherDelta)}</b></div>
  {/if}
  <div class="cell">
    <span class="lab">{renderLabel}</span>
    <b>{renderValue}</b>
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
  {#if chars !== null}
    <div class="cell"><b>{chars}</b> <span class="lab">chars</span></div>
  {/if}
  <div class="cell"><b>{files ?? dash}</b> <span class="lab">files</span></div>
  {#if outside > 0}
    <!-- What changed under you while nothing was watching: the accent's own
         job (§02). Vault-wide and latched like `unresolved`, cleared by the
         next save through the app — which is the moment it stops being news. -->
    <div class="cell">
      <button class="resolve" onclick={() => onoutside?.()}>
        <b class="alert">{outside} outside</b>
      </button>
    </div>
  {/if}
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
  {#if extract === null}
    <div class="cell"><span class="lab">Git</span> <b>{git ?? dash}</b></div>
  {/if}
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
     were pushed past the edge whole rather than tightening: FILES, GIT
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
