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

  // ] and [ toggle the panes. All bare keys, all from <body>.
  //
  // `I` is not here, and this comment used to claim it was — it said "I inverts"
  // and then pressed neither. INV was broken from P9 until someone opened the
  // app and clicked it; a comment is not a test. It has its own now, in
  // inv.spec.ts, which asserts the class actually flips.
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
  //
  // `return true` when nothing is focused used to be the escape hatch: if Tab
  // stopped moving focus at all — every control gaining `tabindex="-1"`, the
  // frame failing to render its buttons, a modal trapping focus on <body> —
  // all eight rounds passed and §02's keyboard promise was unguarded. So the
  // ring is asserted *and* the walk is proved to have gone somewhere.
  const visited: string[] = []
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press('Tab')
    const seen = await page.evaluate(() => {
      const active = document.activeElement
      if (active === null || active === document.body) return null
      const style = getComputedStyle(active)
      const ring = style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
      const id = `${active.tagName}:${active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 20) ?? ''}`
      return { ring, id }
    })
    if (seen === null) continue
    expect(seen.ring, `step ${step} focused ${seen.id} with no visible ring`).toBe(true)
    visited.push(seen.id)
  }

  // Tab reached real controls, and more than one of them — otherwise the loop
  // above proved only that nothing was focusable.
  expect(visited.length, 'Tab never landed on a focusable control').toBeGreaterThan(0)
  expect(
    new Set(visited).size,
    `Tab did not move: ${visited.join(' → ')}`,
  ).toBeGreaterThan(1)
})

test('the index is reachable and traversable with j and k', async ({ page }) => {
  await page.goto(server.url)
  const rows = page.getByRole('complementary', { name: 'Index' }).getByRole('button')
  await expect(rows.first()).toBeVisible()

  // This used to call rows.first().focus() and start from there, which proved
  // the traversal and quietly assumed the hard part. Getting *into* the list
  // took three Tab presses past the theme button, so §02b's "↑↓ / j–k traversal"
  // was only reachable by the mouse's own affordance.
  await page.keyboard.press('j')
  await expect(rows.first()).toBeFocused()

  await page.keyboard.press('j')
  await expect(rows.nth(1)).toBeFocused()
  await page.keyboard.press('k')
  await expect(rows.first()).toBeFocused()

  // Each key keeps its direction: from the frame, `k` arrives at the bottom.
  await page.locator('body').press('Escape')
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.keyboard.press('k')
  await expect(rows.last()).toBeFocused()
})

test('a note opens from the index without the mouse or a single Tab', async ({
  page,
}) => {
  await page.goto(server.url)
  await expect(
    page.getByRole('complementary', { name: 'Index' }).getByRole('button').first(),
  ).toBeVisible()

  await page.keyboard.press('j')
  await page.keyboard.press('Enter')
  // Enter on a row opens it and hands the caret straight to the note, so the
  // whole route is j · Enter · type.
  await expect(page.locator('.cm-content')).toBeFocused()
})

test('j and k are letters wherever someone is typing', async ({ page }) => {
  await page.goto(server.url)
  const rows = page.getByRole('complementary', { name: 'Index' }).getByRole('button')
  await expect(rows.first()).toBeVisible()

  // The whole hazard of binding two letters at the window: in the editor they
  // are prose, and a handler that took them would throw the caret into the
  // sidebar mid-word. Nothing else in the suite types a j or a k into a note.
  await page.getByRole('button', { name: /Alpha/ }).click()
  await expect(page.locator('.cm-content')).toBeFocused()
  await page.keyboard.type('jack kept jokes')
  await expect(page.locator('.cm-content')).toBeFocused()
  await expect(page.locator('.cm-content')).toContainText('jack kept jokes')

  // And in the palette's own box, where they are a query.
  await page.keyboard.press('ControlOrMeta+k')
  const box = page.getByRole('combobox')
  await box.fill('')
  await page.keyboard.type('jk')
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('jk')
})

test('FOCUS · INDEX in the palette survives the palette restoring focus', async ({
  page,
}) => {
  await page.goto(server.url)
  const rows = page.getByRole('complementary', { name: 'Index' }).getByRole('button')
  await expect(rows.first()).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('focus index')
  await page.keyboard.press('Enter')

  // The palette puts focus back where it found it on close. A command whose
  // whole effect is where focus lands has to stand that down, or it is undone a
  // microtask after it runs and reads as a dead row.
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

    // Both edges had to be found. `edge()` returns null for a missing or hidden
    // element, and `null === null` passes — so at the narrow end of this loop,
    // where the inspector and the header's stats cell can hide together, the
    // alignment was silently not compared at all. The 15px misalignment this
    // test exists for lived twelve phases; this is how it could come back at
    // one breakpoint.
    for (const [name, value] of Object.entries(rules)) {
      expect(value, `${name} was not measurable at ${width}px`).not.toBeNull()
    }

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
