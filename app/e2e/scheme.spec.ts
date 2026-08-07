import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

let server: Server
test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/003-a.md': note({ ref: '003', title: 'Alpha', body: 'Body.\n' }),
    }),
  )
})
test.afterAll(async () => await server.stop())

test('a chosen scheme survives a reload; INV does not', async ({ page }) => {
  const dark = () =>
    page.evaluate(() => document.documentElement.classList.contains('dark'))

  await page.goto(server.url)
  await expect(page.getByRole('button', { name: 'INV' })).toBeVisible()

  // Choose Light in Settings — the persistent control (§02b Screen 6).
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('SETTINGS')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await expect.poll(dark, { timeout: 2000 }).toBe(false)

  // It must be in the vault, not in the tab.
  const stored = await (await page.request.get(`${server.url}/api/config`)).json()
  expect(stored.scheme).toBe('light')

  await page.reload()
  await expect(page.getByRole('button', { name: 'INV' })).toBeVisible()
  await expect.poll(dark, { timeout: 3000 }).toBe(false)

  // INV is a transient inversion by design — the spec says "INV inverts", and
  // §02b Screen 6 is where a scheme is chosen. So it must NOT survive a reload.
  await page.keyboard.press('Escape')
  await page.keyboard.press('i')
  await expect.poll(dark, { timeout: 2000 }).toBe(true)
  await page.reload()
  await expect(page.getByRole('button', { name: 'INV' })).toBeVisible()
  await expect.poll(dark, { timeout: 3000 }).toBe(false)
})
