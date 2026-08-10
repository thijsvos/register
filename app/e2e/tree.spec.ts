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

/**
 * One vault and one server serve this whole file, and folding is *persisted* —
 * so without this each test inherited whatever the one before it left folded.
 * That already bit twice: an assertion about hiding a note passed or failed on
 * the order the file happened to run in, which is the kind of green that means
 * nothing. Reset through the API rather than by clicking things back, because a
 * cleanup that goes through the UI is one more thing that can be broken by the
 * bug under test.
 */
test.beforeEach(async ({ page }) => {
  await page.request.put(`${server.url}/api/config`, {
    data: { scheme: 'system', bodyFace: 'default', scale: 'auto', collapsed: [] },
  })
})

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
  // `[]` because beforeEach writes one; on a genuinely fresh vault the key is
  // absent instead, which `asConfig` reads as the same thing.
  expect(await storedCollapsed(page)).toEqual([])

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

test('the arrows work the tree the way every tree widget does', async ({ page }) => {
  // The WAI-ARIA tree pattern, followed exactly because the argument for a tree
  // was that people already know how one behaves — and they know it from
  // widgets that obey this.
  await page.goto(server.url)
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()

  const focused = () =>
    page.evaluate(() => ({
      text: document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      expanded: document.activeElement?.getAttribute('aria-expanded'),
      depth: document.activeElement?.getAttribute('data-depth'),
    }))

  await page.keyboard.press('j') // into the index, on `notes`
  expect((await focused()).text).toMatch(/notes/i)

  // ← on an open folder folds it.
  await page.keyboard.press('ArrowLeft')
  expect(await focused()).toMatchObject({ expanded: 'false', depth: '0' })
  await expect(page.getByRole('button', { name: /Alpha/ })).toHaveCount(0)

  // → on a folded folder opens it, without moving.
  await page.keyboard.press('ArrowRight')
  expect(await focused()).toMatchObject({ expanded: 'true', depth: '0' })
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()

  // → again steps into the first child rather than opening anything.
  await page.keyboard.press('ArrowRight')
  const child = await focused()
  expect(child.text).toMatch(/archive/i)
  expect(child.depth).toBe('1')

  // ← from a folded child steps back out to its parent.
  await page.keyboard.press('ArrowLeft') // folds `archive`
  await page.keyboard.press('ArrowLeft') // steps out to `notes`
  expect((await focused()).text).toMatch(/notes/i)
  expect((await focused()).depth).toBe('0')

  // ← at the top level has nowhere to go, and must not throw or move focus.
  await page.keyboard.press('ArrowLeft') // folds it
  await page.keyboard.press('ArrowLeft') // no parent
  expect((await focused()).text).toMatch(/notes/i)
})

test('← finds the parent, not merely the row above it', async ({ page }) => {
  // The case that separates the two. `001 Alpha` sits at depth 1 directly below
  // `010 Launch plan` at depth 2, so "step to the previous row" and "step to the
  // parent" give different answers — Launch plan against notes. Everywhere else
  // in this fixture they coincide, which is why stepping to the row above
  // survived the whole suite until this existed.
  await page.goto(server.url)
  const alpha = page.getByRole('button', { name: /Alpha/ })
  await expect(alpha).toBeVisible()

  const order = await page
    .locator('[aria-label="Index"] nav button')
    .allInnerTexts()
    .then((all) => all.map((text) => text.replace(/\s+/g, ' ').trim()))
  expect(order[order.indexOf('001 Alpha 3') - 1]).toBe('010 Launch plan 2')

  await alpha.focus()
  await page.keyboard.press('ArrowLeft')
  const landed = await page.evaluate(() => ({
    text: document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    depth: document.activeElement?.getAttribute('data-depth'),
  }))
  expect(landed.text).toMatch(/notes/i)
  expect(landed.text).not.toMatch(/launch/i)
  expect(landed.depth).toBe('0')
})

test('h and l alias the arrows, and → on a note does nothing', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()
  const focused = () =>
    page.evaluate(
      () => document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    )

  await page.keyboard.press('j')
  await page.keyboard.press('h') // folds `notes`, like ←
  await expect(page.getByRole('button', { name: /Alpha/ })).toHaveCount(0)
  await page.keyboard.press('l') // opens it, like →
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()

  // A note is a leaf: → has nothing to expand and nothing to step into, so
  // focus must stay where it is rather than sliding to the next row.
  await page.getByRole('button', { name: /Alpha/ }).focus()
  const before = await focused()
  await page.keyboard.press('ArrowRight')
  expect(await focused()).toBe(before)
})
