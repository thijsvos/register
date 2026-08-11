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
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page.locator('.pal .head')).toContainText('Confirm deletion')
  await expect(page.locator('.pal .foot')).toContainText(
    'Recoverable in .register/trash/',
  )
  // The question carries the target; the buttons carry the answers.
  await expect(page.locator('#pal-question')).toHaveText('Delete notes/001-alpha.md?')
  await expect(page.getByRole('button', { name: /CONFIRM · TRASH/ })).toBeFocused()
  await expect(page.getByRole('button', { name: 'CANCEL' })).toBeVisible()

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
  await expect(page.getByRole('alertdialog')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
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

  await page.getByRole('button', { name: 'CANCEL' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)).toBeOK()
})

test('the confirm is the only thing on offer while it stands', async ({ page }) => {
  // A list of notes under a question about deleting one is an invitation to
  // press Enter on the wrong row. There is nothing else here to press it on —
  // and, since the search box went, nothing to type into either: it accepted
  // typing and ignored it, which is a distraction on the one surface that
  // should have none.
  await focusRow(page, /Alpha/)
  await page.keyboard.press('Backspace')

  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByRole('option')).toHaveCount(0)
  await expect(page.locator('.pal .row')).toHaveCount(2)
  await expect(page.locator('.pal .section')).toHaveCount(0)
})

test('the two answers are the whole keyboard, and Tab cannot leave', async ({ page }) => {
  // `aria-modal` says focus is trapped and nothing enforces that by itself; the
  // text field used to intercept Tab, and it is gone.
  await focusRow(page, /Alpha/)
  await page.keyboard.press('Backspace')

  const confirm = page.getByRole('button', { name: /CONFIRM · TRASH/ })
  const cancel = page.getByRole('button', { name: 'CANCEL' })
  await expect(confirm).toBeFocused()

  // ↑↓ and j–k, the same traversal every nav row takes (§02b).
  await page.keyboard.press('ArrowDown')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('k')
  await expect(confirm).toBeFocused()

  // Tab cycles between the two rather than walking out of the dialog.
  await page.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(confirm).toBeFocused()
})

test('the answer the keyboard is on is the one that reads as chosen', async ({
  page,
}) => {
  // Arming from a *click* leaves `:focus-visible` unmatched, so a rule written
  // that way would draw the question with no visible answer selected while
  // Enter would still confirm.
  await page.goto(server.url)
  await page.getByRole('button', { name: /Launch plan/ }).click()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: /DELETE · NOTE/ }).click()

  const confirm = page.getByRole('button', { name: /CONFIRM · TRASH/ })
  await expect(confirm).toBeFocused()
  const inverse = await confirm.evaluate((node) => {
    const seen = getComputedStyle(node)
    return { background: seen.backgroundColor, outline: seen.outlineStyle }
  })
  const plain = await page
    .getByRole('button', { name: 'CANCEL' })
    .evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(inverse.background).not.toBe(plain)
  expect(inverse.outline).toBe('dashed')
})

test('a folder takes its notes, its nesting and its images', async ({ page }) => {
  await focusRow(page, /projects/i)
  await page.keyboard.press('Backspace')

  // The count is what the INDEX draws: three notes, not the PNG it never showed.
  await expect(page.locator('#pal-question')).toHaveText(
    'Delete notes/projects and everything under it? 3 notes.',
  )

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
  await expect(page.locator('#pal-question')).toContainText('notes/projects')
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

  // The index does not merely lose a row here, it is re-keyed: `notes/` is left
  // holding one folder and nothing else, so the chain compacts and the row that
  // was first is destroyed rather than kept. That is what makes *when* focus is
  // placed matter — before the redraw it lands on an element about to go.
  const after = await rows(page)
  expect(after[0]).toMatch(/^▾ NOTES\/PROJECTS/)
  // A bare row is NOTES followed by its count; the compacted one has a slash.
  expect(after.some((row) => /^▾ NOTES\s/.test(row))).toBe(false)

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
