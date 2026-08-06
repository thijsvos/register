import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §08 P11's keyboard-only and reduced-motion audit.
 *
 * §01 promises a whole session without a mouse and §02 permits exactly one
 * animation. Both are claims that only a browser can check, so they are checked
 * here rather than asserted in a comment.
 */
let server: Server

test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      '000-inbox.md': note({ ref: '000', title: 'Inbox', body: '- [ ] a task\n' }),
      'notes/003-alpha.md': note({
        ref: '003',
        title: 'Alpha',
        body: '# Alpha\n\nBody.\n',
      }),
      'notes/004-beta.md': note({
        ref: '004',
        title: 'Beta',
        body: '# Beta\n\nOther.\n',
      }),
    }),
  )
})

test.afterAll(() => server?.stop())

test('a whole session without touching the mouse', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  // Open a note by name, from the front door.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('Beta')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('Other.')

  // Escape leaves the editor, which is what makes the bare keys reachable.
  await page.keyboard.press('Escape')
  await expect(page.locator('.cm-content')).not.toBeFocused()

  // ] and [ toggle the panes; I inverts. All bare keys, all from <body>.
  await page.keyboard.press(']')
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeHidden()
  await page.keyboard.press(']')
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible()

  await page.keyboard.press('[')
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeHidden()
  await page.keyboard.press('[')
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  // ⌘D is TODAY; the aggregate is reachable and so is the way back.
  await page.keyboard.press('ControlOrMeta+d')
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()

  // Enter from <body> hands the caret back to the note.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('Alpha')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('Body.')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-content')).toBeFocused()
})

test('every focusable control shows a focus ring', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  // §02: "keep focus rings visible". Tab through the frame and require that
  // whatever holds focus draws something — an outline is the design's own way
  // of saying where you are, and `outline: none` is the classic regression.
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press('Tab')
    const drawn = await page.evaluate(() => {
      const active = document.activeElement
      if (active === null || active === document.body) return true
      const style = getComputedStyle(active)
      return style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
    })
    expect(drawn, `step ${step} focused something with no visible ring`).toBe(true)
  }
})

test('the index is traversable with j and k', async ({ page }) => {
  await page.goto(server.url)
  const rows = page.getByRole('complementary', { name: 'Index' }).getByRole('button')
  await rows.first().focus()

  await page.keyboard.press('j')
  await expect(rows.nth(1)).toBeFocused()
  await page.keyboard.press('k')
  await expect(rows.first()).toBeFocused()
})

test('nothing animates under prefers-reduced-motion but nothing breaks either', async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto(server.url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

  // §02 permits one animation — the status LED — and it stills under reduce.
  const running = await page.evaluate(
    () =>
      [...document.querySelectorAll('*')]
        .flatMap((element) => element.getAnimations())
        .filter((animation) => animation.playState === 'running').length,
  )
  expect(running, 'something is still animating under reduced motion').toBe(0)

  // The app still works: reduced motion is not a degraded mode.
  await page.getByRole('button', { name: /Alpha/ }).click()
  await expect(page.locator('.cm-content')).toContainText('Body.')
  await context.close()
})

test('the LED is the only thing that animates at rest', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByText('Live')).toBeVisible()

  const animated = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter((element) => element.getAnimations().length > 0)
      .map((element) => element.className.toString()),
  )

  // One element, and it is the LED.
  expect(animated).toHaveLength(1)
  expect(animated[0]).toContain('led')
})

test('the frame’s vertical rules are continuous through the header', async ({ page }) => {
  // §02: "in a product named after registration marks, two rules 40px out of
  // register is the one misalignment that cannot ship." The left pair has
  // matched since P1. The right pair was 15px out for twelve phases, because
  // the header's right cell was sized by its contents rather than by
  // --frame-insp, and nothing was watching.
  await page.goto(server.url)
  await page.getByRole('button', { name: /Alpha/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  for (const width of [1600, 1400, 1200, 1100]) {
    await page.setViewportSize({ width, height: 900 })
    const rules = await page.evaluate(() => {
      const edge = (selector: string, side: 'left' | 'right') => {
        const element = document.querySelector(selector)
        if (element === null || getComputedStyle(element).display === 'none') return null
        return Math.round(element.getBoundingClientRect()[side])
      }
      return {
        brand: edge('header .brand', 'right'),
        index: edge('aside[aria-label="Index"]', 'right'),
        stats: edge('header .stats', 'left'),
        inspector: edge('aside[aria-label="Inspector"]', 'left'),
      }
    })

    expect(rules.brand, `left rule at ${width}px`).toBe(rules.index)
    expect(rules.stats, `right rule at ${width}px`).toBe(rules.inspector)
  }

  // Below the breakpoint the inspector is gone, so the header must stop
  // reserving room for a rule that no longer exists.
  await page.setViewportSize({ width: 1000, height: 900 })
  const narrow = await page.evaluate(() => {
    const inspector = document.querySelector('aside[aria-label="Inspector"]')
    return {
      // A boolean, not the node: `evaluate` cannot serialise a DOM element and
      // hands back the string "ref: <Node>", which is truthy and proves nothing.
      inspectorShown:
        inspector !== null && getComputedStyle(inspector).display !== 'none',
      reserved: Math.round(
        document.querySelector('header .stats')?.getBoundingClientRect().width ?? 0,
      ),
    }
  })
  expect(narrow.inspectorShown).toBe(false)
  expect(narrow.reserved).toBeLessThan(268)
})
