import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * Following a link without a mouse.
 *
 * §01 promises "every action reachable without a mouse" and §08 P5's done-when
 * is "full session possible without a mouse" — and the wikilink, which §02b
 * calls "the defining interaction", answered `mousedown` and nothing else. The
 * marks have carried `role="link"` and `tabindex="0"` the whole time, so a
 * keyboard user could land on something announced as a link and press Enter
 * into silence.
 */
let server: Server

test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/003-alpha.md': note({
        ref: '003',
        title: 'Alpha',
        body: '[[Beta]] is the next one.\n',
      }),
      'notes/004-beta.md': note({
        ref: '004',
        title: 'Beta',
        body: 'The far side.\n',
      }),
      'notes/005-plain.md': note({
        ref: '005',
        title: 'Plain',
        body: 'Nothing to follow here.\n',
      }),
    }),
  )
})

test.afterAll(() => server?.stop())

/** Open a note the way §01 says you can: without touching the mouse. */
async function open(page: import('@playwright/test').Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill(title)
  await page.keyboard.press('Enter')
}

test('the key follows the wikilink the caret is in', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  await open(page, 'Alpha')
  await expect(page.locator('.cm-content')).toContainText('is the next one')

  // The caret lands past the frontmatter and before the first character of the
  // body, which is the `[` of `[[Beta]]` — so the link under it is the first
  // thing in the note, with no mouse and no arrow keys spent getting there.
  await page.keyboard.press('ControlOrMeta+Enter')

  await expect(page.locator('.cm-content')).toContainText('The far side.')
})

test('the same key still inserts a blank line everywhere else', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  await open(page, 'Plain')
  await expect(page.locator('.cm-content')).toContainText('Nothing to follow')

  // `defaultKeymap` binds Mod-Enter to insertBlankLine. The follow command
  // returns false when there is no link at the caret, so the binding claims
  // only the case it can serve and the editor keeps the rest.
  const before = await page.locator('.cm-line').count()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.locator('.cm-line')).toHaveCount(before + 1)

  // And nothing navigated.
  await expect(page.locator('.cm-content')).toContainText('Nothing to follow')
})

test('⌘K names the key, and runs it', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  await open(page, 'Alpha')
  await expect(page.locator('.cm-content')).toContainText('is the next one')

  // §01: "every control shows its key". §02b draws no keyboard follow, so this
  // row is the only place the binding is written down on screen.
  // Queried by the half of the label no note can match: ⌘K is one surface for
  // commands and full-text search, and `follow` alone finds the note whose body
  // says "nothing to follow here".
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('LINK AT CARET')
  const row = page.getByRole('option', { name: /FOLLOW · LINK AT CARET/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText('⌘↵')

  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('The far side.')
})

test('it says so rather than doing nothing when there is no link', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  await open(page, 'Plain')
  await expect(page.locator('.cm-content')).toContainText('Nothing to follow')

  // The palette offers the command whenever a note is open, because nothing
  // outside the editor can see where the caret is. So the editor answers.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('LINK AT CARET')
  await page.keyboard.press('Enter')

  await expect(page.locator('footer')).toContainText('No link at the caret.')
})

test('a link that announces itself as one answers the key it promises', async ({
  page,
}) => {
  await page.goto(server.url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  await open(page, 'Alpha')
  const link = page.locator('.cm-wiki').first()
  await expect(link).toBeVisible()

  // The mark tells assistive technology it is a link and puts itself in the tab
  // order. Both were true before this and neither was answered.
  await expect(link).toHaveAttribute('role', 'link')
  await expect(link).toHaveAttribute('tabindex', '0')

  await link.focus()
  await expect(link).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.locator('.cm-content')).toContainText('The far side.')
})

test('hovering a link inverts it, like everything else in the frame', async ({
  page,
}) => {
  await page.goto(server.url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  await open(page, 'Alpha')
  const link = page.locator('.cm-wiki').first()
  await expect(link).toBeVisible()

  // §02b's state matrix gives Wikilink hover as "inverse", and inverse video is
  // the one hover idiom in the product. Read off the computed style rather than
  // a screenshot: the tokens differ between light and dark, so the assertion is
  // that the two swap, not what colour they land on.
  const ink = (selector: string) =>
    page.locator(selector).evaluate((el) => getComputedStyle(el).color)
  const paper = (selector: string) =>
    page.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor)

  const bodyInk = await ink('.cm-content')
  expect(await ink('.cm-wiki')).toBe(bodyInk)

  await link.hover()
  await expect.poll(() => paper('.cm-wiki')).not.toBe('rgba(0, 0, 0, 0)')
  expect(await ink('.cm-wiki')).not.toBe(bodyInk)
})
