import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §04's frontmatter: off the editing surface, edited in the inspector.
 *
 * §12: "markdown stays the literal source. Anything that hides the source must
 * still pass §02." So hiding is permitted on a condition, and the condition is
 * that the fields do not stop being editable. Most of this file is that
 * condition — the pane shows every line, writes back through the same buffer a
 * keystroke uses, and splices rather than re-serialises, so every other byte of
 * the note survives.
 */
let server: Server

const PLAIN = note({
  ref: '003',
  title: 'Terminal aesthetics',
  tags: ['design', 'doctrine'],
  body: 'One typeface. Two weights.\n',
})

/** A block that is fenced but holds a line no parser can read. */
const BROKEN = [
  '---',
  'id: 01J2ZK7Q8W3E5R9T000000005',
  'ref: 005',
  'title here — no colon',
  '---',
  'The typo is the point.\n',
].join('\n')

/** The compat fixture's shape: one key, written twice. */
const DOUBLED = [
  '---',
  'id: 01J2ZK7Q8W3E5R9T000000008',
  'ref: 008',
  'title: First',
  'title: Second',
  '---',
  'Which one would the pane draw?\n',
].join('\n')

test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/003-terminal-aesthetics.md': PLAIN,
      'notes/004-second.md': note({ ref: '004', title: 'Second', body: 'Elsewhere.\n' }),
      'notes/005-broken.md': BROKEN,
      'notes/006-bare.md': 'No frontmatter at all, just prose.\n',
      'notes/008-doubled.md': DOUBLED,
      'notes/009-quoted.md': [
        '---',
        'id: 01J2ZK7Q8W3E5R9T000000009',
        'ref: 009',
        'title: "Costs: a study"',
        '---',
        'A colon that needs its quotes.\n',
      ].join('\n'),
    }),
  )
})

test.afterAll(() => server?.stop())

/** The PROPERTIES row for one key, as the pane draws it. */
const value = (page: import('@playwright/test').Page, key: string) =>
  page.getByRole('textbox', { name: key })

async function open(page: import('@playwright/test').Page, name: string | RegExp) {
  await page.getByRole('button', { name }).click()
}

async function onDisk(page: import('@playwright/test').Page, path: string) {
  return await (await page.request.get(`${server.url}/api/note/${path}`)).text()
}

test('a note opens on its prose, with no YAML above it', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  const shown = await page.locator('.cm-content').innerText()
  expect(shown).not.toContain('01J2ZK7Q8W3E5R9T')
  expect(shown).not.toContain('tags:')
  expect(shown).not.toContain('---')
  expect(shown.trimStart().startsWith('One typeface.')).toBe(true)

  // Nothing is drawn in its place either. The first attempt put a collapsible
  // row there, which is a control on the one surface meant to have none.
  await expect(page.locator('.cm-frontmatter-fold')).toHaveCount(0)
})

test('every field is in the pane, and the pane is where they are edited', async ({
  page,
}) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  await expect(value(page, 'title')).toHaveValue('Terminal aesthetics')
  await expect(value(page, 'tags')).toHaveValue('[design, doctrine]')

  await value(page, 'title').fill('Terminal aesthetics, revised')
  await page.keyboard.press('Enter')

  // Through the same buffer and the same debounced save a keystroke takes.
  await expect
    .poll(() => onDisk(page, 'notes/003-terminal-aesthetics.md'), { timeout: 5000 })
    .toContain('title: Terminal aesthetics, revised')

  // And the note's own header follows it, because both read the buffer.
  await expect(page.locator('header.note h2')).toHaveText('Terminal aesthetics, revised')
})

test('one field changes and every other byte survives', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Second/)
  await expect(page.locator('.cm-content')).toContainText('Elsewhere.')

  await value(page, 'tags').fill('[one, two]')
  await page.keyboard.press('Enter')

  await expect
    .poll(() => onDisk(page, 'notes/004-second.md'), { timeout: 5000 })
    .toContain('tags: [one, two]')

  // `setField` splices one line. Key order, the body and the fences are all
  // exactly as they were — the §04 round-trip contract, through a form.
  const after = await onDisk(page, 'notes/004-second.md')
  const before = note({ ref: '004', title: 'Second', body: 'Elsewhere.\n' })
  const lineOf = (text: string, key: string) =>
    text.split('\n').findIndex((line) => line.startsWith(`${key}:`))
  for (const key of ['id', 'ref', 'title', 'created', 'tags']) {
    expect(lineOf(after, key), key).toBe(lineOf(before, key))
  }
  expect(after.endsWith('Elsewhere.\n')).toBe(true)
})

test('the value shown is the line as written, quotes and all', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Costs/)
  await expect(page.locator('.cm-content')).toContainText('needs its quotes')

  // Shown unquoted, this would be written back without them, and the colon
  // would read as a second mapping the next time anything parsed the file.
  await expect(value(page, 'title')).toHaveValue('"Costs: a study"')
})

test('id and ref are shown and cannot be edited', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  // §04 calls both immutable, and a `[[NNN]]` link resolves by ref — so editing
  // one would re-point every link to the note.
  await expect(value(page, 'id')).toHaveCount(0)
  await expect(value(page, 'ref')).toHaveCount(0)
  await expect(page.locator('.props')).toContainText('003')
})

test('Escape puts back what the file says', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  const before = await onDisk(page, 'notes/003-terminal-aesthetics.md')

  await value(page, 'tags').fill('[abandoned]')
  await page.keyboard.press('Escape')

  await expect(value(page, 'tags')).toHaveValue('[design, doctrine]')
  expect(await onDisk(page, 'notes/003-terminal-aesthetics.md')).toBe(before)
})

test('a note with no frontmatter is left alone', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /bare|006/)
  await expect(page.locator('.cm-content')).toContainText('just prose')
  await expect(page.locator('aside[aria-label="Inspector"]')).toContainText(
    'No frontmatter.',
  )
})

test('a block the pane could not stand in for stays on screen', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /broken|005/)
  await expect(page.locator('.cm-content')).toContainText('The typo is the point.')

  // Hiding it would hide the only thing worth looking at, and the pane cannot
  // show a line it cannot parse.
  await expect(page.locator('.cm-content')).toContainText('title here — no colon')
})

test('a key written twice stays on screen', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /doubled|008/)
  await expect(page.locator('.cm-content')).toContainText('Which one would the pane')

  // The pane is a map and would draw one row; `setField` rewrites the first
  // match. So the row shown and the line written could be different lines.
  await expect(page.locator('.cm-content')).toContainText('title: First')
  await expect(page.locator('.cm-content')).toContainText('title: Second')
})

test('the caret cannot be walked into text it cannot see', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  // The hazard `bodyOffset` exists for, made worse by hiding the block: at
  // offset 0 the caret sits ABOVE the opening fence, and the first character
  // typed pushes it off byte zero — the note stops parsing as a note, loses its
  // title, ref and tags, and nothing on screen showed it happening.
  await page.locator('.cm-line', { hasText: 'One typeface.' }).click()
  await page.keyboard.press('ControlOrMeta+ArrowUp')
  await page.keyboard.press('Home')
  await page.keyboard.type('XX')

  const after = await onDisk(page, 'notes/003-terminal-aesthetics.md')
  expect(after.startsWith('---\n')).toBe(true)
  expect(after).toContain('ref: 003')
})
