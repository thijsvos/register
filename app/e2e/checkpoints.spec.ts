import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02b Screen 6 gains a switch for the one flag only the server reads.
 *
 * Until now `"checkpoints": true` could only be written by hand into
 * `.register/config.json` — the directory the vault's own agent contract says
 * never to touch — so the product's only history mechanism was reachable only
 * by breaking the product's own rule.
 */

let server: Server
test.beforeEach(async () => {
  const vault = vaultWith({ 'notes/001-alpha.md': note({ ref: '001', title: 'Alpha' }) })
  execFileSync('git', ['-C', vault, 'init', '--quiet'], { stdio: 'pipe' })
  server = await serve(vault)
})
test.afterEach(async () => await server.stop())

test('checkpoints switch on from the settings screen, and keep what they do not own', async ({
  page,
}) => {
  // A key nobody on this screen has heard of, already in the file.
  const seeded = await page.request.put(`${server.url}/api/config`, {
    data: { agent: 'claude' },
    headers: { 'content-type': 'application/json' },
  })
  expect(seeded.status()).toBe(204)

  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('GO · SETTINGS')
  await page.getByRole('option').filter({ hasText: 'GO · SETTINGS' }).first().click()

  const on = page.getByRole('button', { name: 'On', exact: true })
  await expect(on).toHaveAttribute('aria-pressed', 'false')
  await on.click()
  await expect(on).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.settings')).toContainText(/90 s of quiet/)

  // The file the server reads, with the flag the server reads — and the key
  // the screen could not show, still there.
  await expect
    .poll(async () => (await page.request.get(`${server.url}/api/config`)).json())
    .toMatchObject({ checkpoints: true, agent: 'claude' })

  await page.getByRole('button', { name: 'Off', exact: true }).click()
  await expect
    .poll(async () => (await page.request.get(`${server.url}/api/config`)).json())
    .toMatchObject({ checkpoints: false, agent: 'claude' })
})
