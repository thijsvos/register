import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02b Screen 1's document header — three rows the frame draws and the editor
 * column never grew:
 *
 *     NOTE · REF 003 · REV 07
 *     Terminal aesthetics  (sentence)
 *     ┌created┬modified┬words┬status┐
 *
 * "Layout is the source of truth ... fidelity to these frames is a review gate,
 * not a suggestion." Every other main-column surface stamps itself; this was the
 * one that opened a note and said nothing about it.
 */
let server: Server

test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/003-terminal-aesthetics.md': note({
        ref: '003',
        title: 'Terminal aesthetics',
        body: 'One typeface. Two weights.\n',
      }),
    }),
  )
})

test.afterAll(() => server?.stop())

test('Screen 1 draws the note above its own body', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  const head = page.locator('header.note')

  // `NOTE · REF 003`, uppercased by CSS as all chrome is (§02).
  await expect(head.locator('.stamp')).toHaveText('Note · Ref 003')

  // The title line, in the writer's own sentence case rather than the
  // instrument's uppercase.
  const title = head.getByRole('heading', { level: 2 })
  await expect(title).toHaveText('Terminal aesthetics')
  await expect(title).toHaveCSS('text-transform', 'none')

  // The strip: created / modified / words / chars. REV and STATUS are absent on
  // purpose — §04's note format carries neither, and §02b forbids a gauge for a
  // number the system cannot measure.
  const cells = head.locator('.meta .cell')
  await expect(cells).toHaveCount(4)
  await expect(cells.nth(0)).toContainText('2026-08-05')
  // The `T` traded for a space, which is `utcStamp`'s shape and the chrome's.
  await expect(cells.nth(1)).toContainText('2026-08-05 09:16:40Z')
  await expect(cells.nth(2)).toContainText('4')
  await expect(cells.nth(3)).toContainText(String('One typeface. Two weights.\n'.length))
})

test('the meta strip counts what is typed, as it is typed', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  const words = page.locator('header.note .meta .cell').nth(2)
  const before = Number(await words.innerText().then((t) => t.replace(/\D/g, '')))

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' three more words')

  // §08 P4: "Words/chars ... live". Not on save, and not on reload.
  await expect
    .poll(async () => Number((await words.innerText()).replace(/\D/g, '')))
    .toBe(before + 3)
})
