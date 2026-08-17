import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02b Screens 9 and 10, and §04 Rev Y's move.
 *
 * The three that needed a surface rather than a rule: what is in the trash, what
 * the INDEX never draws, and reorganising a vault without Finder.
 */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

let server: Server
test.beforeEach(async () => {
  server = await serve(
    vaultWith({
      'notes/001-alpha.md': note({ ref: '001', title: 'Alpha' }),
      'notes/010-launch.md': note({
        ref: '010',
        title: 'Launch plan',
        body: 'A plan.\n\n![The frame](diagram.png)\n',
      }),
      'notes/diagram.png': PNG,
      'notes/orphan.png': PNG,
    }),
  )
})
test.afterEach(async () => await server.stop())

const openPalette = async (page: import('@playwright/test').Page, query: string) => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill(query)
}

/**
 * Delete a note through the API, then reload.
 *
 * The trash screens are about what happens *after* a deletion, and driving the
 * deletion through the palette first coupled them to its focus model — ⌘K
 * toggles, so a surface still open from the previous step is closed by it rather
 * than opened. `delete.spec.ts` already covers the palette route in full; these
 * tests are about the surface that shows what it left behind.
 */
async function deleteAndReload(page: import('@playwright/test').Page, path: string) {
  const response = await page.request.delete(`${server.url}/api/note/${path}`)
  expect(response.status(), 'the fixture could not be deleted').toBe(204)
  await page.goto(server.url)
}

test('the trash lists a deletion and puts it back', async ({ page }) => {
  // Deleting never destroyed anything; the only way back was a `mv` in Finder,
  // which meant knowing the bucket name and reading a notice carefully at the
  // moment you were least inclined to.
  await page.goto(server.url)
  await deleteAndReload(page, 'notes/001-alpha.md')

  await openPalette(page, 'GO · TRASH')
  await page.getByRole('option').filter({ hasText: 'GO · TRASH' }).first().click()
  await expect(page.locator('.trash h2')).toHaveText('Trash')
  await expect(page.locator('.trash .what').first()).toContainText('notes/001-alpha.md')

  await page
    .getByRole('button', { name: /restore/i })
    .first()
    .click()

  // Back at its original path, which is what the bucket layout is for.
  await expect
    .poll(async () =>
      (await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)).status(),
    )
    .toBe(200)
  // And the bucket is gone with it: an empty row can do nothing.
  await expect(page.locator('.trash .rows li')).toHaveCount(0)
})

test('a restore never overwrites what lives there now', async ({ page }) => {
  // §04 never destroys, and a restore that clobbered the note now at that path
  // would be the one operation in this product that did.
  await page.goto(server.url)
  await deleteAndReload(page, 'notes/001-alpha.md')

  // Something else takes the path.
  await page.request.put(`${server.url}/api/note/notes/001-alpha.md`, {
    data: '---\nref: 001\ntitle: Something else\n---\nMine now.\n',
    headers: { 'content-type': 'text/markdown' },
  })

  await openPalette(page, 'GO · TRASH')
  await page.getByRole('option').filter({ hasText: 'GO · TRASH' }).first().click()
  await expect(page.locator('.trash .note')).toContainText(/already lives/i)

  await page
    .getByRole('button', { name: /restore/i })
    .first()
    .click()
  await expect(page.locator('footer')).toContainText(/left in the trash/i)

  const held = await (
    await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)
  ).text()
  expect(held).toContain('Mine now.')
  // Still recoverable: nothing was thrown away to make room.
  await expect(page.locator('.trash .rows li')).toHaveCount(1)
})

test('attachments shows what references what, and what nothing does', async ({
  page,
}) => {
  // The INDEX is a register of notes, so an image whose note was deleted is
  // invisible in the app.
  await page.goto(server.url)
  await openPalette(page, 'GO · ATTACHMENTS')
  await page.getByRole('option').filter({ hasText: 'GO · ATTACHMENTS' }).first().click()
  await expect(page.locator('.attachments h2')).toHaveText('Attachments')

  const rows = page.locator('.attachments .rows li')
  await expect(rows).toHaveCount(2)
  // Referenced, so it names the note — worked out from the corpus here rather
  // than asked of the server, which would mean it parsing prose.
  await expect(rows.filter({ hasText: 'notes/diagram.png' })).toContainText('Launch plan')
  await expect(rows.filter({ hasText: 'notes/orphan.png' })).toContainText(
    /referenced by nothing/i,
  )
})

test('moving a note repoints the image it left behind', async ({ page }) => {
  // The framing this feature carried — "does the app rewrite your prose" —
  // overstated it: wikilinks resolve by ref or title and survive untouched. Only
  // a relative `![](src)` needs help, and only when the note moves away from it.
  await page.goto(server.url)
  await page
    .getByRole('button', { name: /Launch plan/ })
    .first()
    .click()
  await expect(page.locator('.cm-content')).toContainText('A plan.')

  await openPalette(page, 'MOVE archive')
  await page.getByRole('option').filter({ hasText: 'MOVE · NOTE' }).first().click()

  // The confirm says how many notes it will edit before it edits any.
  await expect(page.locator('#pal-question')).toContainText('archive/010-launch.md')
  await expect(page.locator('#pal-question')).toContainText(/repoints 1 reference/i)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () =>
      (await page.request.get(`${server.url}/api/note/archive/010-launch.md`)).status(),
    )
    .toBe(200)
  // Polled, not read once: the move and the repoint are two writes in that
  // order, deliberately — a failure between them leaves every file on disk and
  // a stale reference, where the other order edits notes to point at a move
  // that then does not happen. So the second one lands a moment later.
  await expect
    .poll(async () =>
      (await page.request.get(`${server.url}/api/note/archive/010-launch.md`)).text(),
    )
    // Re-pointed at the image it already meant, and kept relative — §12 wants
    // markdown to stay the literal source.
    .toContain('![The frame](../notes/diagram.png)')
})
