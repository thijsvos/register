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
export default defineConfig({
  testDir: './e2e',
  // Timings are the point of half these tests, and a parallel worker measuring
  // latency while another worker builds a 1000-note vault measures the machine.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // §02b Screen 1's frame: wide enough for the sidebar, the measure and the
    // inspector, so nothing under test is hidden by a breakpoint.
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
  },
})
