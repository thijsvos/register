import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02b Screen 1's INDEX as a folder tree (Rev N).
 *
 * The pane was flat, so a vault with structure looked like a vault with a
 * shuffled list — and at a thousand notes a flat list is a scroll, not an index.
 * Nesting always worked underneath; this is the drawing of it.
 */

let server: Server
test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      '000-inbox.md': note({ ref: '000', title: 'Inbox', body: 'Loose at the root.\n' }),
      'notes/001-alpha.md': note({
        ref: '001',
        title: 'Alpha',
        body: 'One level down.\n',
      }),
      'notes/archive/018-old.md': note({
        ref: '018',
        title: 'Retired',
        body: 'Filed away.\n',
      }),
      'notes/projects/apollo/010-launch.md': note({
        ref: '010',
        title: 'Launch plan',
        body: 'Three deep.\n',
      }),
    }),
  )
})
test.afterAll(async () => await server.stop())

const rows = (page: import('@playwright/test').Page) =>
  page
    .locator('[aria-label="Index"] nav button')
    .allInnerTexts()
    .then((all) => all.map((text) => text.replace(/\s+/g, ' ').trim()))

const storedCollapsed = async (page: import('@playwright/test').Page) =>
  (await (await page.request.get(`${server.url}/api/config`)).json()).collapsed

test('draws the folders the vault actually has', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()

  // Folders before notes, each alphabetical — what every file tree does, which
  // is the whole reason this is a tree and not a list.
  // `projects/apollo` is one row: a chain holding a single folder earns one
  // level of indent, not two.
  expect(await rows(page)).toEqual([
    '▾ NOTES 3',
    '▾ ARCHIVE 1',
    '018 Retired 2',
    '▾ PROJECTS/APOLLO 1',
    '010 Launch plan 2',
    '001 Alpha 3',
    '000 Inbox 4',
  ])
})

test('a folded folder hides its notes, and stays folded across a reload', async ({
  page,
}) => {
  await page.goto(server.url)
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()
  // Absent, not []: a fresh vault's config.json is `{}` and stays that way
  // until something is actually chosen.
  expect(await storedCollapsed(page)).toBeUndefined()

  await page.getByRole('button', { name: /archive/i }).click()
  await expect(page.getByRole('button', { name: /Retired/ })).toHaveCount(0)

  // In the vault, not the tab: hard rule 4 forbids state the vault cannot
  // express, and polled rather than read once because the write is in flight
  // behind the render — the race scheme.spec.ts documents three times.
  await expect
    .poll(() => storedCollapsed(page), { timeout: 3000 })
    .toEqual(['notes/archive'])

  await page.reload()
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Retired/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /archive/i })).toHaveAttribute(
    'aria-expanded',
    'false',
  )

  // And the way back.
  await page.getByRole('button', { name: /archive/i }).click()
  await expect(page.getByRole('button', { name: /Retired/ })).toBeVisible()
  await expect.poll(() => storedCollapsed(page), { timeout: 3000 }).toEqual([])
})

test('an open note is visible even inside a folder you folded shut', async ({ page }) => {
  // A note you cannot see in the index is a note the index is not doing its job
  // for. Revealing is computed at render time rather than by un-collapsing, so
  // what is stored stays what the reader chose.
  await page.goto(server.url)
  await page.getByRole('button', { name: /archive/i }).click()
  await expect(page.getByRole('button', { name: /Retired/ })).toHaveCount(0)
  await expect
    .poll(() => storedCollapsed(page), { timeout: 3000 })
    .toEqual(['notes/archive'])

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('Retired')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('Filed away')

  // Revealed…
  await expect(page.getByRole('button', { name: /Retired/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /archive/i })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  // …without rewriting the choice. Opening a note is not a decision about folders.
  expect(await storedCollapsed(page)).toEqual(['notes/archive'])
})

test('the keyboard traverses folders and notes alike', async ({ page }) => {
  // §02b gives a nav row "↑↓ / j–k traversal". A folder is a nav row, so it is
  // in the sequence rather than skipped — otherwise the keyboard could reach
  // notes it cannot expand its way to.
  await page.goto(server.url)
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()

  await page.keyboard.press('j')
  const focused = () =>
    page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
  expect(await focused()).toMatch(/notes/i)

  await page.keyboard.press('j')
  expect(await focused()).toMatch(/archive/i)

  // Enter on a folder folds it, rather than trying to open it as a note.
  //
  // Asserted as a *toggle* rather than against a known starting state: the
  // specs in this file share one vault and one server, and the test above ends
  // with `notes/archive` deliberately left collapsed. Written as "Enter hides
  // the note" this passed or failed on the order the file happened to run in,
  // which is the kind of green that means nothing.
  const archive = page.getByRole('button', { name: /archive/i })
  const before = await archive.getAttribute('aria-expanded')
  await page.keyboard.press('Enter')
  await expect(archive).toHaveAttribute(
    'aria-expanded',
    before === 'true' ? 'false' : 'true',
  )
  await expect(page.getByRole('button', { name: /Retired/ })).toHaveCount(
    before === 'true' ? 0 : 1,
  )
})
