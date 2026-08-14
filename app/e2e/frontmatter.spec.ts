import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §04's frontmatter, folded to one row (§02b Screen 1).
 *
 * §12: "markdown stays the literal source. Anything that hides the source must
 * still pass §02." So this is permitted on a condition, and the conditions are
 * what most of this file asserts: the row is a control that shows its key, it
 * is reachable without a mouse, and — the one that matters most — the bytes on
 * disk are untouched by any of it.
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

test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/003-terminal-aesthetics.md': PLAIN,
      'notes/004-second.md': note({ ref: '004', title: 'Second', body: 'Elsewhere.\n' }),
      'notes/005-broken.md': BROKEN,
      'notes/006-bare.md': 'No frontmatter at all, just prose.\n',
      'notes/007-one.md': '---\ntitle: Alone\n---\nOne field only.\n',
    }),
  )
})

test.afterAll(() => server?.stop())

const row = (page: import('@playwright/test').Page) =>
  page.locator('.cm-frontmatter-fold')

async function open(page: import('@playwright/test').Page, name: string | RegExp) {
  await page.getByRole('button', { name }).click()
}

test('a note opens with its frontmatter folded to one row', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  // Six §04 fields, counted rather than guessed. Sentence case in the DOM and
  // uppercase on screen, which is how all chrome in this app is written (§02).
  await expect(row(page)).toHaveText(/6 fields/)
  await expect(row(page)).toHaveCSS('text-transform', 'uppercase')
  await expect(row(page)).toContainText('↵')

  // And the six lines are genuinely not on screen.
  const shown = await page.locator('.cm-content').innerText()
  expect(shown).not.toContain('01J2ZK7Q8W3E5R9T')
  expect(shown).not.toContain('tags:')
  expect(shown).toContain('One typeface.')
})

test('the row opens the block, and the caret lands in it', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await expect(row(page)).toBeVisible()

  await row(page).click()

  await expect(row(page)).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('01J2ZK7Q8W3E5R9T')
  // Opening it is something you do to edit it, so the caret is already there:
  // typing goes into the frontmatter rather than into the note above it.
  const line = await page.evaluate(() => {
    const selection = document.getSelection()
    return selection?.anchorNode?.parentElement?.closest('.cm-line')?.textContent ?? ''
  })
  expect(line).toContain('id:')
})

test('it folds again when the caret leaves', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await row(page).click()
  await expect(row(page)).toHaveCount(0)

  // Back to the prose. Nothing to press and nothing to remember: leaving is
  // done, which is what makes the fold worth having.
  await page.locator('.cm-line', { hasText: 'One typeface.' }).click()
  await expect(row(page)).toBeVisible()
})

test('folding rewrites nothing — the note on disk is byte for byte what it was', async ({
  page,
}) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await expect(row(page)).toBeVisible()

  await row(page).click()
  await expect(row(page)).toHaveCount(0)
  await page.locator('.cm-line', { hasText: 'One typeface.' }).click()
  await expect(row(page)).toBeVisible()

  // The whole promise of §12's "literal source": what an agent reads is what
  // was there before anyone looked at it in a browser.
  const onDisk = await (
    await page.request.get(`${server.url}/api/note/notes/003-terminal-aesthetics.md`)
  ).text()
  expect(onDisk).toBe(PLAIN)
})

test('every note opens folded, however the last one was left', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await row(page).click()
  await expect(row(page)).toHaveCount(0)

  await open(page, /Second/)
  await expect(page.locator('.cm-content')).toContainText('Elsewhere.')
  await expect(row(page)).toBeVisible()
})

test('it counts in the singular when there is one field', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Alone/)
  await expect(page.locator('.cm-content')).toContainText('One field only.')

  // "1 fields" is the kind of thing that makes a reader distrust the number
  // beside it, and the number is all this row has to say.
  await expect(row(page)).toHaveText(/\b1 field\b/)
})

test('a note with no frontmatter draws no row', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /006-bare|bare/)
  await expect(page.locator('.cm-content')).toContainText('just prose')

  // Nothing to fold is not the same as a folded nothing.
  await expect(row(page)).toHaveCount(0)
})

test('a block that does not parse stays open', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /005-broken|broken/)
  await expect(page.locator('.cm-content')).toContainText('The typo is the point.')

  // Folding would hide the only thing worth looking at.
  await expect(row(page)).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('title here — no colon')
})

test('the row is a control the keyboard can reach and open', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await expect(row(page)).toBeVisible()

  // §01: "every action reachable without a mouse". Tab from the editor reaches
  // it the way it reaches a wikilink, and it announces what it is.
  await expect(row(page)).toHaveAttribute('role', 'button')
  await row(page).focus()
  await expect(row(page)).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(row(page)).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('01J2ZK7Q8W3E5R9T')
})

test('the caret cannot be walked into text it cannot see', async ({ page }) => {
  await page.goto(server.url)
  await open(page, /Terminal aesthetics/)
  await expect(row(page)).toBeVisible()

  // The hazard `bodyOffset` exists for, made worse by hiding the block: at
  // offset 0 the caret sits ABOVE the opening fence, and the first character
  // typed pushes it off byte zero — the note stops parsing as a note, loses its
  // title, ref and tags, and nothing on screen showed it happening.
  await page.locator('.cm-line', { hasText: 'One typeface.' }).click()
  await page.keyboard.press('ControlOrMeta+ArrowUp')
  await page.keyboard.press('Home')
  await page.keyboard.type('XX')

  const onDisk = await (
    await page.request.get(`${server.url}/api/note/notes/003-terminal-aesthetics.md`)
  ).text()
  expect(onDisk.startsWith('---\n')).toBe(true)
  expect(onDisk).toContain('ref: 003')
})
