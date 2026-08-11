import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §04 Rev P: deleting a note, and deleting a folder with everything under it.
 *
 * The app had no delete of any kind before this — `deleteNote` existed in the
 * client and was only ever used to retire a conflict copy — so what these
 * assert is a surface, not a fix: that a destructive action asks first, that
 * the answer it acts on is the one shown, and that nothing can reach the
 * operation without passing through the question.
 *
 * A real PNG, because the argument for doing folder deletion on the server is
 * that a loop over `DELETE /api/note` leaves the images behind — and only a
 * file the server will actually serve can prove it did not.
 */

const PNG = readFileSync(join(process.cwd(), '..', 'docs', 'screenshot.png'))

/** A fresh vault per test: every one of these is destructive by definition. */
async function vault(): Promise<Server> {
  return await serve(
    vaultWith({
      'notes/001-alpha.md': note({ ref: '001', title: 'Alpha', body: 'Loose.\n' }),
      'notes/projects/010-launch.md': note({
        ref: '010',
        title: 'Launch plan',
        body: 'A diagram:\n\n![The frame](diagram.png)\n',
      }),
      'notes/projects/011-budget.md': note({ ref: '011', title: 'Budget' }),
      'notes/projects/deep/012-nested.md': note({ ref: '012', title: 'Nested' }),
      // Invisible to the INDEX, and the whole reason the counts differ.
      'notes/projects/diagram.png': PNG,
    }),
  )
}

let server: Server
test.beforeEach(async () => {
  server = await vault()
})
test.afterEach(async () => await server.stop())

const rows = (page: Page) =>
  page
    .locator('[aria-label="Index"] nav button')
    .allInnerTexts()
    .then((all) => all.map((text) => text.replace(/\s+/g, ' ').trim()))

/** Focus a row by its visible name, the way the keyboard reaches one. */
async function focusRow(page: Page, name: RegExp): Promise<void> {
  await page.goto(server.url)
  const row = page.locator('[aria-label="Index"] nav button', { hasText: name })
  await expect(row).toHaveCount(1)
  await row.focus()
}

test('a note is not deleted until the question is answered', async ({ page }) => {
  await focusRow(page, /Alpha/)
  await page.keyboard.press('Backspace')

  // Armed, not done. The palette is the confirm surface — §02b's answer to a
  // modal was "never a modal", and this is already the app's dialog.
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.pal .head')).toContainText('Confirm deletion')
  await expect(page.locator('.pal .foot')).toContainText(
    'Recoverable in .register/trash/',
  )
  await expect(
    page.getByRole('option', { name: /CONFIRM · TRASH 001-alpha\.md/ }),
  ).toBeVisible()
  await expect(page.getByRole('option', { name: 'CANCEL' })).toBeVisible()

  // Still there while the question stands.
  expect(await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)).toBeOK()

  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /Alpha/ })).toHaveCount(0)
  expect(
    (await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)).status(),
  ).toBe(404)
  await expect(page.locator('footer .notice')).toContainText('.register/trash/')
})

test('escape answers no, and nothing is deleted', async ({ page }) => {
  await focusRow(page, /Alpha/)
  await page.keyboard.press('Backspace')
  await expect(page.getByRole('dialog')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()
  expect(await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)).toBeOK()

  // And the answer does not linger: reopening the palette must not still be
  // holding a question about deleting something.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.locator('.pal .head')).toContainText('Command & search')
})

test('CANCEL is a row, not only a key', async ({ page }) => {
  await focusRow(page, /Alpha/)
  await page.keyboard.press('Backspace')

  await page.getByRole('option', { name: 'CANCEL' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)).toBeOK()
})

test('the confirm is the only thing on offer while it stands', async ({ page }) => {
  // A list of notes under a question about deleting one is an invitation to
  // press Enter on the wrong row — and the palette's Enter runs whatever is
  // selected. Two rows, and typing cannot reach past them.
  await focusRow(page, /Alpha/)
  await page.keyboard.press('Backspace')

  await expect(page.getByRole('option')).toHaveCount(2)
  await page.keyboard.type('alpha')
  await expect(page.getByRole('option')).toHaveCount(2)
  await expect(page.locator('.pal .section')).toContainText('Confirm')
})

test('a folder takes its notes, its nesting and its images', async ({ page }) => {
  await focusRow(page, /projects/i)
  await page.keyboard.press('Backspace')

  // The count is what the INDEX draws: three notes, not the PNG it never showed.
  await expect(
    page.getByRole('option', { name: /CONFIRM · TRASH notes\/projects · 3 notes/ }),
  ).toBeVisible()

  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: /Launch plan/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Nested/ })).toHaveCount(0)
  // Alpha was not in it.
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()

  // The image went too. This is the property the endpoint exists for: a client
  // looping over DELETE /api/note cannot move it — `trash` is .md-only — so it
  // would still be served from a folder the INDEX now draws as gone.
  expect(
    (
      await page.request.get(`${server.url}/api/file/notes/projects/diagram.png`)
    ).status(),
  ).toBe(404)

  // And the notice reports what actually moved, which is more than was counted.
  await expect(page.locator('footer .notice')).toContainText('3 notes and 1 file')
})

test('deleting the folder you are reading in closes the note', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Launch plan/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: /DELETE · FOLDER/ }).click()
  await expect(
    page.getByRole('option', { name: /CONFIRM · TRASH notes\/projects/ }),
  ).toBeVisible()
  await page.keyboard.press('Enter')

  // A buffer still bound to a path with nothing behind it would be written
  // straight back by the next debounced save.
  await expect(page.locator('.cm-content')).toHaveCount(0)
  await expect(page.locator('main .empty')).toBeVisible()
})

test('deleting from the index leaves the keyboard in the index', async ({ page }) => {
  // §01's mouse-free promise breaks on the *next* keystroke, not this one: the
  // row the palette would restore focus to is the thing that was just deleted,
  // so without a deliberate landing place focus ends on <body>.
  await focusRow(page, /Alpha/)
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: /Alpha/ })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .toBe('BUTTON')
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest('[aria-label="Index"]') !== null,
      ),
    )
    .toBe(true)
})

test('an emptied folder does not linger in the index', async ({ page }) => {
  // A folder row exists because a note is under it, so this follows from the
  // tree — but the directory on disk is what §04 calls the truth, and the two
  // have to agree. `deep/` held one note.
  await focusRow(page, /Nested/)
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: /Nested/ })).toHaveCount(0)
  expect(await rows(page)).not.toContain('▾ DEEP 1')
  // And the folder it was in is gone from disk with it, not left empty behind
  // an index that says it is not there.
  expect(
    (await page.request.delete(`${server.url}/api/folder/notes/projects/deep`)).status(),
  ).toBe(404)
})

test('the vault root is not something the API will delete', async ({ page }) => {
  await page.goto(server.url)
  for (const path of ['/api/folder/', '/api/folder/.', '/api/folder/..']) {
    const refused = await page.request.delete(`${server.url}${path}`)
    expect(refused.status(), path).toBeGreaterThanOrEqual(400)
  }
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()
})
