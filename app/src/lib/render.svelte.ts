import { flushSync } from 'svelte'

/** The most recent render REGISTER performed, and what caused it. */
interface Render {
  ms: number
  /**
   * Notes the vault gained or lost in the burst that caused this render, when
   * the watcher caused it. Null when we did — a keystroke, a scheme flip.
   *
   * Null and zero mean different things and the status bar reads both: zero is
   * an agent editing a note that already existed, which changes no count and is
   * still a watcher render (§02b Screen 7).
   */
  delta: number | null
}

let last = $state<Render | null>(null)

export const render = {
  /** The cost of the most recent render, in milliseconds. */
  get ms(): number | null {
    return last?.ms ?? null
  },
  /** Non-null when the watcher caused it, and by how many notes. */
  get delta(): number | null {
    return last?.delta ?? null
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
  last = { ms, delta: null }
}

/**
 * Close a watcher round trip: `since` is when the event frame arrived, `delta`
 * is what the vault's note count did across the burst (§02b Screen 7).
 *
 * The flush is the whole point — it brackets the DOM mutation the event caused,
 * so the figure means "event to repaint" and not "event to state assignment".
 * It is the same interval §06 budgets at 100 ms and `budgets.spec.ts` measures
 * from outside with a MutationObserver; this is the app reporting its own.
 */
export function setWatcherRender(since: number, delta: number): void {
  flushSync()
  last = { ms: performance.now() - since, delta }
}

export function measure<T>(work: () => T): T {
  const t0 = performance.now()
  const result = work()
  flushSync()
  last = { ms: performance.now() - t0, delta: null }
  return result
}
