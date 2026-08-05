import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §08 P11's journey, in order: boot → new note → type → ⌘K nav → checkbox →
 * reload persists → external-edit hot-reload.
 *
 * One server for the file, because the journey is cumulative — what the second
 * step writes, the sixth step reloads.
 */
let server: Server

test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      '000-inbox.md': note({
        ref: '000',
        title: 'Inbox',
        tags: ['capture'],
        body: '- [ ] first thing\nSee [[Terminal aesthetics]].\n',
      }),
      'notes/003-terminal-aesthetics.md': note({
        ref: '003',
        title: 'Terminal aesthetics',
        tags: ['design'],
        body: '# Terminal aesthetics\n\nOne typeface. Two weights.\n',
      }),
    }),
  )
})

test.afterAll(() => server?.stop())

test('boots to a usable frame', async ({ page }) => {
  await page.goto(server.url)

  // §02b Screen 1: the frame is header / sidebar / editor / inspector / status.
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Terminal aesthetics/ })).toBeVisible()
  // Chrome shows only derivable truth: the watcher is live because it is.
  await expect(page.getByText('Watcher')).toBeVisible()
  await expect(page.getByText('Live')).toBeVisible()
})

test('opens a note, types, and the text reaches the file', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()

  // P5's focus fix: opening a note puts the caret in it, so typing goes to the
  // note and not to the global keymap.
  const editor = page.locator('.cm-content')
  await expect(editor).toBeFocused()

  // Straight at the caret, wherever the app put it. That is the point: the
  // caret must land past the frontmatter, or this keystroke unmakes the note.
  await page.keyboard.type('Hairlines are chrome.')

  // §06 budgets a UI edit to disk at 600 ms, measured from the edit.
  const path = join(server.vault, 'notes/003-terminal-aesthetics.md')
  await expect
    .poll(() => readFileSync(path, 'utf8'), { timeout: 2000 })
    .toContain('Hairlines are chrome.')

  // §04: `modified` is the one field the UI rewrites, and nothing else moved.
  const written = readFileSync(path, 'utf8')
  expect(written.startsWith('---\n')).toBe(true)
  expect(written).toContain('ref: 003')
  expect(written).toContain('tags: [design]')
  // The typed text is prose, not a new first line above the fence.
  expect(written.indexOf('Hairlines')).toBeGreaterThan(written.indexOf('tags:'))
})

test('⌘K searches the corpus and navigates without a mouse', async ({ page }) => {
  await page.goto(server.url)
  // The keymap is installed by an effect. Pressing before the frame is on
  // screen presses at nothing, and the failure looks like a broken shortcut.
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command and search' })
  await expect(palette).toBeVisible()

  // Real full-text search: "typeface" is in a body, not in any title (§02b).
  await page.getByRole('combobox').fill('typeface')
  const hit = palette.getByRole('option').first()
  await expect(hit).toContainText('Terminal aesthetics')

  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page.locator('.cm-content')).toContainText('One typeface')
})

test('a checkbox toggles in place and writes through to the file', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Inbox/ }).first().click()

  const box = page.getByRole('checkbox').first()
  await expect(box).toHaveAttribute('aria-checked', 'false')
  await box.click()

  const path = join(server.vault, '000-inbox.md')
  await expect
    .poll(() => readFileSync(path, 'utf8'), { timeout: 2000 })
    .toContain('- [x] first thing')
})

test('a reload shows what the last session wrote', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toContainText('Hairlines are chrome.')

  await page.reload()
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toContainText('Hairlines are chrome.')
})

test('an external edit repaints without a reload', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  // The headline demo (§02b Screen 7): an agent writes the file, the UI moves.
  appendFileSync(
    join(server.vault, 'notes/003-terminal-aesthetics.md'),
    '\nWritten from a terminal.\n',
  )
  await expect(page.locator('.cm-content')).toContainText('Written from a terminal.', {
    timeout: 3000,
  })
})

test('a note created on disk appears in the index', async ({ page }) => {
  await page.goto(server.url)

  writeFileSync(
    join(server.vault, 'notes/004-perf-doctrine.md'),
    note({ ref: '004', title: 'Perf doctrine', tags: ['perf'], body: 'Sixteen ms.\n' }),
  )

  await expect(page.getByRole('button', { name: /Perf doctrine/ })).toBeVisible({
    timeout: 3000,
  })
})
