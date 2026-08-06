<script lang="ts">
import { utcStamp } from '../../lib/time'

let {
  crumb = 'INDEX',
  pressed = false,
  oninvert,
  onpalette,
}: {
  crumb?: string
  pressed?: boolean
  oninvert: () => void
  onpalette: () => void
} = $props()

let clock = $state(utcStamp())

// Aligned to the second boundary and self-correcting. A bare setInterval
// inherits whatever sub-second phase the mount landed on, so a UTC readout
// would sit up to a second stale, and it never re-syncs after the timer is
// throttled in a background tab or the machine sleeps.
$effect(() => {
  let id: ReturnType<typeof setTimeout>
  const tick = () => {
    clock = utcStamp()
    id = setTimeout(tick, 1000 - (Date.now() % 1000))
  }
  tick()
  return () => clearTimeout(id)
})
</script>

<header>
  <div class="brand">
    <h1 class="mark"><span aria-hidden="true">■</span> REGISTER</h1>
    <div class="sub">Second brain system</div>
  </div>
  <div class="crumb">{crumb}</div>
  <div class="stats">
    <time datetime={clock.replace(' ', 'T')}>{clock}</time>
    <button class="key" aria-pressed={pressed} title="Invert display" onclick={oninvert}>
      INV
    </button>
    <!-- §01: every control shows its key, and §02b Screen 1 draws it here. -->
    <button class="key" title="Command and search" onclick={onpalette}>⌘K</button>
  </div>
</header>

<style>
header {
  display: flex;
  align-items: stretch;
  border-bottom: var(--hairline) solid var(--line);
}

/* Matches --frame-side so the brand rule and the sidebar rule are one
   continuous vertical hairline — in a product named after registration marks,
   two rules 40px out of register is the one misalignment that cannot ship. */
.brand {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--hairline);
  padding: 0 var(--s4);
  border-right: var(--hairline) solid var(--line);
  min-width: var(--frame-side);
}
.mark {
  font-weight: 700;
  font-size: var(--text-mark);
  letter-spacing: var(--track-mark);
  color: var(--hi);
}
.sub {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}

.crumb {
  flex: 1;
  display: flex;
  align-items: center;
  padding: 0 var(--s4);
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  text-transform: uppercase;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The same rule as .brand, on the other side: --frame-insp so the header's
   right hairline and the inspector's left hairline are one continuous vertical
   line. The left pair has matched since P1 and this one never did — 15px out,
   which in a product named after registration marks is the misalignment that
   cannot ship. Contents stay against the right edge, so widening the cell moves
   the rule and nothing else. */
.stats {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--s2);
  padding: 0 var(--s4);
  min-width: var(--frame-insp);
  border-left: var(--hairline) solid var(--line);
}
time {
  font-size: var(--text-ui);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* §02b state matrix, Button / key: 1px box · hover inverse · aria-pressed
   inverse · dashed focus ring offset 2px (inherited from base.css). */
.key {
  border: var(--hairline) solid var(--line);
  padding: var(--key-pad-y) var(--s2);
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  white-space: nowrap;
}
.key:hover,
.key[aria-pressed='true'] {
  background: var(--sel-bg);
  color: var(--sel-fg);
}

/* The inspector is gone below this width (App.svelte, Inspector.svelte), so
   there is no rule left to line up with and the reserved width would only
   squeeze the crumb. */
@media (max-width: 1080px) {
  .stats { min-width: 0; }
}

@media (max-width: 760px) {
  .brand { min-width: 0; }
  .crumb { display: none; }
}
</style>
