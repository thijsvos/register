import { expect, type Page, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §04: creating a note somewhere other than `notes/`, and the folder coming
 * into being with it.
 *
 * There is no "new folder" command and there should not be: a folder is not a
 * thing this vault stores — the INDEX derives one from the paths of the notes
 * under it — so an empty directory is something the app cannot draw. The
 * feature is choosing where a note goes; the folder follows.
 */

let server: Server
test.beforeEach(async () => {
  server = await serve(
    vaultWith({
      'notes/001-alpha.md': note({ ref: '001', title: 'Alpha' }),
      'notes/projects/010-launch.md': note({ ref: '010', title: 'Launch plan' }),
      'notes/projects/deep/011-nested.md': note({ ref: '011', title: 'Nested' }),
      'notes/personal/012-diary.md': note({ ref: '012', title: 'Diary' }),
      'templates/daily.md': note({ ref: '000', title: 'TEMPLATE', body: '# Day\n' }),
    }),
  )
})
test.afterEach(async () => await server.stop())

const rowNames = (page: Page) =>
  page
    .getByRole('option')
    .allInnerTexts()
    .then((all) => all.map((text) => text.replace(/\s+/g, ' ').trim()))

/** Every note path the vault holds, from the API rather than from the screen. */
async function paths(page: Page): Promise<string[]> {
  const tree = await (await page.request.get(`${server.url}/api/tree`)).json()
  return tree.notes.map((entry: { path: string }) => entry.path).sort()
}

/**
 * Wait for a path to exist on disk.
 *
 * Creation is several round trips — refresh for the ref, confirm the name is
 * free, write, refresh again — so reading the tree straight after a keystroke
 * asks the question before the answer exists. Three of these tests failed that
 * way and the app was right every time.
 */
async function expectPath(page: Page, path: string): Promise<void> {
  await expect.poll(() => paths(page)).toContain(path)
}

test('two letters suggest the folder they could name', async ({ page }) => {
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('pr')

  // Subsequence matching against the whole path, the rule ⌘K already uses for
  // commands — so `pr` reaches `notes/projects` without typing `notes/`.
  const suggestions = await rowNames(page)
  expect(suggestions.some((row) => row.includes('notes/projects'))).toBe(true)
  await expect(page.locator('.pal .section', { hasText: 'Folders' })).toBeVisible()
})

test('one letter suggests nothing, because everything would match', async ({ page }) => {
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('p')

  await expect(page.locator('.pal .section', { hasText: 'Folders' })).toHaveCount(0)
})

test('choosing a folder types it, and creates nothing', async ({ page }) => {
  await page.goto(server.url)
  const before = await paths(page)

  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('proj')
  await page
    .getByRole('option', { name: /notes\/projects/ })
    .first()
    .click()

  // Completed, not created: picking a place to write is not writing.
  await expect(page.locator('.pal input')).toHaveValue('notes/projects/')
  expect(await paths(page)).toEqual(before)

  // And the suggestions narrow to what is inside it rather than repeating it.
  const inside = await rowNames(page)
  expect(inside.some((row) => row.includes('notes/projects/deep'))).toBe(true)
})

test('the folder stops being suggested once a title follows it', async ({ page }) => {
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('notes/projects/Launch the thing')

  // Nothing has to notice that you stopped naming a place and started naming a
  // note; the match simply stops holding.
  await expect(page.locator('.pal .section', { hasText: 'Folders' })).toHaveCount(0)
})

test('a note is created into the folder that was typed', async ({ page }) => {
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('proj')
  await page
    .getByRole('option', { name: /notes\/projects/ })
    .first()
    .click()
  await page.keyboard.type('Launch the thing')

  // The template row says where it will land before it is pressed.
  const stencil = page.getByRole('option', { name: /TEMPLATE/ })
  await expect(stencil).toContainText('notes/projects/')
  await stencil.click()

  // Read off the note's own header rather than out of the raw `title:` line:
  // §04's frontmatter folds to one row now, so the YAML is in the document and
  // not on the screen — and the header is where a reader actually looks for
  // what the note is called.
  await expect(page.locator('header.note h2')).toHaveText('Launch the thing')
  await expectPath(page, 'notes/projects/013-launch-the-thing.md')
  // The register is the vault's, not the folder's: 012 was the highest.
  await expect(page.locator('header .crumb')).toContainText('013')
})

test('a folder that does not exist yet is made by writing into it', async ({ page }) => {
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('notes/archive/Retired thing')
  await page.getByRole('option', { name: /TEMPLATE/ }).click()

  await expectPath(page, 'notes/archive/013-retired-thing.md')
  // And the INDEX draws it, which is the only sense in which a folder exists.
  await expect(page.getByRole('button', { name: /archive/i })).toBeVisible()
})

test('N on a focused folder row creates inside it', async ({ page }) => {
  await page.goto(server.url)
  const row = page.locator('[aria-label="Index"] nav button', { hasText: /personal/i })
  await expect(row).toHaveCount(1)
  await row.focus()
  await page.keyboard.press('n')

  await expect(page.locator('.cm-content')).toBeVisible()
  await expectPath(page, 'notes/personal/013-untitled-note.md')
})

test('N on a focused note row creates beside it', async ({ page }) => {
  await page.goto(server.url)
  const row = page.locator('[aria-label="Index"] nav button', { hasText: /Nested/ })
  await row.focus()
  await page.keyboard.press('n')

  await expectPath(page, 'notes/projects/deep/013-untitled-note.md')
})

test('N with the index untouched still means notes/', async ({ page }) => {
  // The key kept its old meaning everywhere it always had one.
  await page.goto(server.url)
  await page.getByRole('button', { name: /Alpha/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('n')

  await expectPath(page, 'notes/013-untitled-note.md')
})
