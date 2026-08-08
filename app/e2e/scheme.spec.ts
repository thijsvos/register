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

test('a chosen scheme survives a reload, however it was chosen', async ({ page }) => {
  const dark = () =>
    page.evaluate(() => document.documentElement.classList.contains('dark'))
  const storedScheme = async () =>
    (await (await page.request.get(`${server.url}/api/config`)).json()).scheme

  await page.goto(server.url)
  await expect(page.getByRole('button', { name: 'INV' })).toBeVisible()

  // Choose Light in Settings — the persistent control (§02b Screen 6).
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('SETTINGS')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await expect.poll(dark, { timeout: 2000 }).toBe(false)

  // It must be in the vault, not in the tab. Polled, not read once: the class
  // flips synchronously and the PUT is still in flight behind it, so a single
  // read races the write and fails only under load — which is exactly when the
  // whole suite runs.
  await expect.poll(storedScheme, { timeout: 3000 }).toBe('light')

  await page.reload()
  await expect(page.getByRole('button', { name: 'INV' })).toBeVisible()
  await expect.poll(dark, { timeout: 3000 }).toBe(false)

  // INV is the same act as pressing Light or Dark, so it persists too. It used
  // to be a preview — press it, get light, refresh, get dark — which read as a
  // broken button, and the distinction was never visible on screen.
  await page.keyboard.press('Escape')
  await page.keyboard.press('i')
  await expect.poll(dark, { timeout: 2000 }).toBe(true)

  await expect
    .poll(storedScheme, { timeout: 3000, message: 'INV did not reach the vault' })
    .toBe('dark')

  await page.reload()
  await expect(page.getByRole('button', { name: 'INV' })).toBeVisible()
  await expect.poll(dark, { timeout: 3000 }).toBe(true)

  // And back again by the button, still persisting.
  await page.getByRole('button', { name: 'INV' }).click()
  await expect.poll(dark, { timeout: 2000 }).toBe(false)

  // Wait for the vault, not just the class — the same race this file already
  // guards twice above and did not guard here. `invert()` flips the class
  // synchronously and fires the PUT without awaiting it, so reloading on the
  // strength of the class alone races the write: fine on a laptop, and on a
  // shared runner the reload wins and the reloaded page reads the *old* scheme.
  // It failed exactly that way on CI.
  await expect
    .poll(storedScheme, {
      timeout: 3000,
      message: 'the INV button did not reach the vault',
    })
    .toBe('light')

  await page.reload()
  await expect(page.getByRole('button', { name: 'INV' })).toBeVisible()
  await expect.poll(dark, { timeout: 3000 }).toBe(false)
})
