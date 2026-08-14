import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02b Screen 1's document header, and what it deliberately does not draw.
 *
 * The frame puts three rows above the body — a kicker, a title, and a
 * `┌created┬modified┬words┬status┐` strip. The strip is not built: `created`
 * and `modified` are editable rows in the inspector, `words` and `chars` are
 * readouts in the status rail beside RENDER, and REV and STATUS name data §04's
 * note format does not carry. What is left is the note saying what it is.
 *
 * Every other main-column surface stamps itself; this was the one that opened a
 * note and said nothing about it at all.
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

  // And it sits on the body's own left edge. This is asserted rather than
  // eyeballed because it broke silently the moment the meta strip came out: a
  // grid item with auto margins does not stretch, so the header had been the
  // width of whatever was widest inside it, and the strip was propping it out
  // to the measure. Without the strip the title centred on itself, 116px right
  // of the prose it belongs to.
  const edge = async (selector: string) =>
    await page
      .locator(selector)
      .first()
      .evaluate((el) => Math.round(el.getBoundingClientRect().left))
  expect(await edge('header.note')).toBe(await edge('.cm-content'))

  // And the title sits close enough to the note to belong to it. The gap is two
  // paddings — the heading's and the editor's own top inset — which is why
  // halving it took a change in each, and why measuring one of them would not
  // have caught the other growing back.
  const gap = await page.evaluate(() => {
    const heading = document.querySelector('header.note h2')
    const line = document.querySelector('.cm-line')
    if (heading === null || line === null) return Number.NaN
    const under = Number.parseFloat(getComputedStyle(heading).paddingBottom)
    const glyphs = heading.getBoundingClientRect().bottom - under
    return Math.round(line.getBoundingClientRect().top - glyphs)
  })
  expect(gap).toBe(24)
})

test('and draws nothing that is already somewhere else', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  // The strip repeated the inspector: `created` and `modified` are rows there,
  // and editable ones, so the note carried the same two values twice.
  await expect(page.locator('header.note .meta')).toHaveCount(0)
  await expect(page.locator('header.note')).not.toContainText('2026-08-05')

  // They are still on screen, once, where they can also be changed.
  await expect(page.getByRole('textbox', { name: 'created' })).toHaveValue('2026-08-05')
})

test('the counts live in the status rail, beside the other readout', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  // §08 P4 asks for "Words/chars + RENDER ms live" in one breath, and this is
  // the rail RENDER is in.
  const bar = page.locator('footer')
  await expect(bar).toContainText('4 words')
  await expect(bar).toContainText(`${'One typeface. Two weights.\n'.length} chars`)

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' three more words')

  // Live: not on save, and not on reload.
  await expect(bar).toContainText('7 words')
})
