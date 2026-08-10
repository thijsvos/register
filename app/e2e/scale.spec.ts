import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02 "Plate" — the frame renders at whole multiples of the specified size.
 *
 * Every assertion here measures **geometry**, never a class or an aria-pressed
 * attribute. A class proves the setter ran; it does not prove a single pixel
 * moved, and the whole defect this closes was a frame that had the right classes
 * and rendered at 15% of a 3440px screen. `19abca0` is the same lesson from the
 * scheme: the test that reloaded on the strength of a class, not a write.
 */

let server: Server
test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/003-a.md': note({ ref: '003', title: 'Alpha', body: 'Body text.\n' }),
    }),
  )
})
test.afterAll(async () => await server.stop())

/** The header rail: 44px of plate, so 44 at 1x and 88 at 2x. */
const railHeight = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => document.querySelector('header')?.getBoundingClientRect().height ?? 0,
  )

const storedScale = async (page: import('@playwright/test').Page) =>
  (await (await page.request.get(`${server.url}/api/config`)).json()).scale

async function openSettings(page: import('@playwright/test').Page) {
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('SETTINGS')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Auto', exact: true })).toBeVisible()
}

test('an unset scale follows the canvas, and the reading column follows with it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(server.url)
  await page.getByRole('button', { name: /Alpha/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  const measure = () =>
    page.evaluate(
      () => document.querySelector('.cm-content')?.getBoundingClientRect().width ?? 0,
    )

  expect(await railHeight(page)).toBe(44)
  const narrowProse = await measure()
  expect(narrowProse).toBeGreaterThan(0)

  // The complaint, in one assertion. Asserted as a RATIO against the 1x
  // measurement rather than as "greater than zero" or "wider than 600" — both of
  // which pass against a feature that does nothing at all.
  await page.setViewportSize({ width: 3440, height: 1440 })
  await expect.poll(() => railHeight(page), { timeout: 2000 }).toBe(88)
  expect(await measure()).toBeCloseTo(narrowProse * 2, -0.5)

  // Nothing is stored, and that is the point: auto is the classless default in
  // tokens.css, so it holds from the first frame rather than waiting for a
  // config fetch. A fresh vault's config.json is `{}` and stays that way until
  // something is actually chosen.
  expect(await storedScale(page)).toBeUndefined()
})

test('a pinned scale is obeyed, persists, and can be unpinned', async ({ page }) => {
  await page.setViewportSize({ width: 3440, height: 1440 })
  await page.goto(server.url)
  await expect.poll(() => railHeight(page), { timeout: 2000 }).toBe(88)

  await openSettings(page)
  await page.getByRole('button', { name: '1×', exact: true }).click()

  // A pin must beat the canvas, or "1x" on an ultrawide means nothing.
  await expect.poll(() => railHeight(page), { timeout: 2000 }).toBe(44)

  // Polled, not read once: setScale fires the PUT without the render awaiting
  // it, so reloading on the strength of the rendering races the write — the
  // exact failure scheme.spec.ts documents at three separate call sites.
  await expect
    .poll(() => storedScale(page), {
      timeout: 3000,
      message: 'the pin never reached the vault',
    })
    .toBe(1)

  await page.reload()
  await expect.poll(() => railHeight(page), { timeout: 3000 }).toBe(44)

  // The way back. A setting you cannot unset is a one-way door (Settings.svelte).
  await openSettings(page)
  await page.getByRole('button', { name: 'Auto', exact: true }).click()
  await expect.poll(() => railHeight(page), { timeout: 2000 }).toBe(88)
  await expect.poll(() => storedScale(page), { timeout: 3000 }).toBe('auto')
})

test('a scale pinned on a wide display does not follow the vault to a small one', async ({
  page,
}) => {
  // §07 serves one vault to every device the user owns, and config.json lives
  // inside that vault — so 2x chosen on the ultrawide is read verbatim by the
  // laptop. Without the canvas veto the laptop draws a three-column frame into
  // half its width and loses the index, the inspector and the status bar.
  await page.setViewportSize({ width: 3440, height: 1440 })
  await page.goto(server.url)
  await openSettings(page)
  await page.getByRole('button', { name: '2×', exact: true }).click()
  await expect.poll(() => storedScale(page), { timeout: 3000 }).toBe(2)

  await page.setViewportSize({ width: 1400, height: 900 })
  await page.reload()

  // Still 2 in the vault — the setting travelled and was not rewritten.
  expect(await storedScale(page)).toBe(2)
  // But the plate is 1x here, because there is no room for anything else.
  await expect.poll(() => railHeight(page), { timeout: 3000 }).toBe(44)

  const frame = await page.evaluate(() => {
    const shown = (selector: string) => {
      const element = document.querySelector(selector)
      return element !== null && getComputedStyle(element).display !== 'none'
    }
    const footer = document.querySelector('footer')?.getBoundingClientRect()
    return {
      index: shown('aside[aria-label="Index"]'),
      inspector: shown('aside[aria-label="Inspector"]'),
      footerBottom: Math.round(footer?.bottom ?? 0),
      innerHeight: window.innerHeight,
      overflowX:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  expect(frame.index).toBe(true)
  expect(frame.inspector).toBe(true)
  expect(frame.overflowX).toBe(0)
  expect(frame.footerBottom).toBe(frame.innerHeight)
})

test('the frame still fits the viewport at 2x, status bar included', async ({ page }) => {
  // Viewport units resolve against the UNZOOMED viewport, so an undivided
  // 100dvh at 2x makes the app twice the viewport tall and pushes the status bar
  // off-screen behind html{overflow:hidden} — with no scrollbar to reach it, so
  // nothing about it looks broken except that the bar is gone.
  await page.setViewportSize({ width: 3440, height: 1440 })
  await page.goto(server.url)
  await expect.poll(() => railHeight(page), { timeout: 2000 }).toBe(88)

  const fit = await page.evaluate(() => {
    const footer = document.querySelector('footer')?.getBoundingClientRect()
    const root = document.documentElement
    return {
      footerBottom: Math.round(footer?.bottom ?? 0),
      innerHeight: window.innerHeight,
      overflowX: root.scrollWidth - root.clientWidth,
      overflowY: root.scrollHeight - root.clientHeight,
      crosses: [...document.querySelectorAll('.cross')].length,
    }
  })
  expect(fit.footerBottom).toBe(fit.innerHeight)
  expect(fit.overflowX).toBe(0)
  expect(fit.overflowY).toBe(0)
  expect(fit.crosses).toBe(4)

  // §02b Screen 2 puts the palette at 11vh with a 52vh result list — the same
  // unzoomed-viewport trap, and the palette is the one surface that renders
  // outside .app, so it is scaled by the root and nothing else.
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('combobox')
  await expect(palette).toBeVisible()
  const within = await page.evaluate(() => {
    const box = document.querySelector('[role="combobox"]')?.closest('div')
    const rect = box?.getBoundingClientRect()
    return rect !== undefined && rect.bottom <= window.innerHeight && rect.top >= 0
  })
  expect(within).toBe(true)
})

test('the editor places the caret on the character clicked at 2x', async ({ page }) => {
  // CodeMirror does its own getBoundingClientRect arithmetic for the caret and
  // selection, on a channel entirely separate from the Svelte components — so it
  // is the one surface that could scale visually and still be wrong to click.
  await page.setViewportSize({ width: 3440, height: 1440 })
  await page.goto(server.url)
  await page.getByRole('button', { name: /Alpha/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect.poll(() => railHeight(page), { timeout: 2000 }).toBe(88)

  const hit = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((element) =>
      element.textContent?.startsWith('Body text.'),
    )
    if (line === undefined) return null
    const rect = line.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(line)
    const width = range.getBoundingClientRect().width / (line.textContent?.length ?? 1)
    return { x: rect.left + width * 5 + width / 2, y: rect.top + rect.height / 2 }
  })
  expect(hit).not.toBeNull()
  if (hit === null) return

  await page.mouse.click(hit.x, hit.y)
  const offset = await page.evaluate(() => window.getSelection()?.anchorOffset ?? -1)
  expect(offset).toBe(5)
})

test('choosing a scale does not discard the other settings', async ({ page }) => {
  // #save() writes an explicit literal rather than a spread, which is correct —
  // a spread would carry transient font state into the vault — but it means a
  // field left out of it is silently never persisted. Nothing in this suite set
  // one setting and checked another survived until a third field existed.
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(server.url)
  await openSettings(page)

  await page.getByRole('button', { name: 'Teletype · Server' }).click()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`${server.url}/api/config`)).json()).scheme,
      { timeout: 3000 },
    )
    .toBe('dark')

  await page.getByRole('button', { name: '1×', exact: true }).click()
  await expect.poll(() => storedScale(page), { timeout: 3000 }).toBe(1)

  const config = await (await page.request.get(`${server.url}/api/config`)).json()
  expect(config).toEqual({
    scheme: 'dark',
    bodyFace: 'teletype',
    scale: 1,
    collapsed: [],
  })
})
