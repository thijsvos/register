import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * The Content-Security-Policy has to be one the app can actually run under.
 *
 * It shipped in v0.3.0 forbidding inline scripts while `index.html` still had
 * one — the pre-paint scheme bootstrap — so every load began with a violation
 * and booted in the wrong scheme. Nothing caught it: the journey tests drive the
 * UI and never look at the console, and a blocked script fails silently by
 * design. So this test watches the console rather than the pixels.
 */
let server: Server

test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/003-a.md': note({ ref: '003', title: 'Alpha', body: 'Body.\n' }),
    }),
  )
})
test.afterAll(async () => await server.stop())

test('the page boots with no policy violation and no script error', async ({ page }) => {
  // Three buckets, because one list cannot be asserted on: a blocked resource
  // logs a bare "Failed to load resource" that names no URL, and `/api/font` is
  // 404 by design until a licensed face is loaded (§03). Lumping them together
  // would mean either tolerating everything or failing on the expected 404.
  const violations: string[] = []
  const thrown: string[] = []
  const failedRequests: string[] = []

  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (/content security policy/i.test(message.text())) violations.push(message.text())
  })
  page.on('pageerror', (error) => thrown.push(String(error.message)))
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/api/font')) {
      failedRequests.push(`HTTP ${response.status()} ${response.url()}`)
    }
  })

  await page.goto(server.url)
  await expect(page.getByRole('button', { name: 'INV' })).toBeVisible()
  await page.waitForTimeout(600)

  expect(violations, `the page violates its own CSP:\n${violations.join('\n')}`).toEqual(
    [],
  )
  expect(thrown, `uncaught at boot:\n${thrown.join('\n')}`).toEqual([])
  expect(failedRequests, `requests failed:\n${failedRequests.join('\n')}`).toEqual([])

  // The bootstrap must still be a real, served file rather than a dead tag.
  const boot = await page.request.get(`${server.url}/boot.js`)
  expect(boot.status()).toBe(200)
})
