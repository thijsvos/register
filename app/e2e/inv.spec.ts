import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * INV had no test. `audit.spec.ts` says "] and [ toggle the panes; I inverts"
 * and then presses only `]` and `[` — the comment claimed a coverage the
 * assertions never provided, which is how a dead button reached a release.
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

test('INV inverts the display, by button and by key', async ({ page }) => {
  await page.goto(server.url)
  const button = page.getByRole('button', { name: 'INV' })
  await expect(button).toBeVisible()

  const dark = () =>
    page.evaluate(() => document.documentElement.classList.contains('dark'))

  const before = await dark()

  await button.click()
  await expect.poll(dark, { timeout: 2000 }).toBe(!before)

  await button.click()
  await expect.poll(dark, { timeout: 2000 }).toBe(before)

  // …and the bare key, which is the same toggle.
  await page.keyboard.press('Escape')
  await page.keyboard.press('i')
  await expect.poll(dark, { timeout: 2000 }).toBe(!before)
})
