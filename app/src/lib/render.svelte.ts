import { flushSync } from 'svelte'

let lastMs = $state<number | null>(null)

/** The cost of the most recent render REGISTER performed, in milliseconds. */
export const render = {
  get ms(): number | null {
    return lastMs
  },
}

/**
 * Run `work` and record what it cost, with Svelte's DOM flush forced inside the
 * bracket so the number covers the state change, the resulting DOM mutation and
 * the style invalidation it triggers.
 *
 * It deliberately excludes the browser's own paint. Timing to a
 * requestAnimationFrame callback looks like the obvious way to "measure to
 * paint", but rAF runs at the START of the frame's rendering step — before
 * style, layout and paint — so that interval brackets none of the render work
 * and consists almost entirely of idle waiting for the next vsync. It would
 * report 0–16.7 ms of scheduling phase as though it were our cost, which is the
 * fabricated-gauge anti-pattern §02b retired. This reports only work we can
 * actually attribute to ourselves.
 */
/** Report a cost measured elsewhere — the editor times its own updates. */
export function setRenderMs(ms: number): void {
  lastMs = ms
}

export function measure<T>(work: () => T): T {
  const t0 = performance.now()
  const result = work()
  flushSync()
  lastMs = performance.now() - t0
  return result
}
