import { defineConfig, devices } from '@playwright/test'

/**
 * §08 P11 — Playwright against the real binary.
 *
 * Not against `vite dev`. Every budget in §06 is a claim about what ships, and
 * what ships is one Rust binary with the UI embedded in it; a dev server proves
 * something else. Each spec starts its own `register serve` on an ephemeral
 * port against its own temporary vault, so nothing shares state and nothing
 * depends on a fixture surviving the previous file.
 */
/**
 * §02b Screen 1's frame: wide enough for the sidebar, the measure and the
 * inspector, so nothing under test is hidden by a breakpoint.
 */
const FRAME = { width: 1400, height: 900 }

export default defineConfig({
  testDir: './e2e',
  // `shots.spec.ts` writes the README's screenshots rather than asserting
  // anything, so it is not part of the suite — it is run on purpose, by
  // `pnpm shots`, when the frame has changed enough that the pictures lie.
  // Kept as code rather than as two files somebody remembers to recapture,
  // because a screenshot nobody can regenerate is a screenshot that goes stale.
  //
  // Gated on the variable rather than excluded outright: `testIgnore` wins even
  // when the file is named on the command line, so an unconditional one makes
  // the shots unrunnable rather than opt-in.
  testIgnore: process.env.SHOTS === undefined ? '**/shots.spec.ts' : [],
  // Timings are the point of half these tests, and a parallel worker measuring
  // latency while another worker builds a 1000-note vault measures the machine.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  /**
   * Three engines, because the product makes claims only a browser can settle
   * and was proving them in the one least likely to disagree.
   *
   * §02's plate scale is `zoom` on `<html>` interacting with `dvh`, which is
   * exactly the corner where engines differ — and `scale.spec.ts` asserts the
   * whole of it, including that the status bar stays inside the viewport at 2×.
   * That is six tests and a normative §02 revision resting on Chromium alone.
   * The roadmap has carried the entry since the plate scale landed and calls
   * the fix what it is: "config, not doctrine".
   *
   * The viewport is restated per project rather than shared. Each `devices`
   * entry brings its own — Desktop Firefox is 1280×720 — and a project's `use`
   * wins over the top-level one, so a single shared viewport would silently
   * apply to Chromium and to nothing else.
   */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: FRAME } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: FRAME } },
    // Run on a Mac, where this is the engine Safari ships; CI does not gate on
    // it. Playwright's Linux build is the WebKitGTK port rather than Safari, and
    // it failed three specs on the runner that all pass here — a document switch
    // at 255 ms against a 250 ms allowance, a conflict copy that did not appear
    // inside five seconds, and a wheel gesture. Those are facts about the port.
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: FRAME } },
  ],
})
