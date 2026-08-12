import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * Clicking a line below an embedded image puts the caret on that line.
 *
 * A block widget's height is guessed before its bytes arrive — `estimatedHeight`
 * exists so an undrawn image does not measure as an empty box. Nothing told
 * CodeMirror when the guess stopped being true, so its height map kept the
 * estimate while the browser drew the real thing, and every coordinate below the
 * image mapped to the wrong document position. One image put the caret a line
 * out; two put it two lines out.
 */

const PNG = readFileSync(join(process.cwd(), '..', 'docs', 'screenshot.png'))

let server: Server
test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/001-embeds.md': note({
        ref: '001',
        title: 'Embeds',
        body: [
          'ALPHA line one',
          '',
          '![first](shot.png)',
          '',
          'BRAVO after the first image',
          '',
          '![second](shot.png)',
          '',
          'CHARLIE after the second image',
          '',
          'DELTA the last line',
          '',
        ].join('\n'),
      }),
      'notes/shot.png': PNG,
    }),
  )
})
test.afterAll(async () => await server.stop())

/** The text of the line the caret is actually sitting in. */
async function caretLine(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const node = window.getSelection()?.anchorNode
    const element = node instanceof Element ? node : (node?.parentElement ?? null)
    return element?.closest('.cm-line')?.textContent ?? '(none)'
  })
}

/** Click the visible line whose text starts with `word`. */
async function clickLine(page: Page, word: string): Promise<void> {
  await page
    .locator('.cm-line', { hasText: new RegExp(`^${word}`) })
    .first()
    .click()
}

test('the caret lands on the line that was clicked, under one image', async ({
  page,
}) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Embeds/ }).click()
  await expect(page.locator('.cm-embed-image').first()).toBeVisible()
  // Both images decoded, so the layout is the one a reader is clicking on.
  await expect
    .poll(() =>
      page
        .locator('.cm-embed-image')
        .evaluateAll((all) =>
          all.every((img) => (img as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true)

  await clickLine(page, 'BRAVO')
  expect(await caretLine(page)).toContain('BRAVO')
})

test('and under two images, where the error used to double', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Embeds/ }).click()
  await expect(page.locator('.cm-embed-image').first()).toBeVisible()
  await expect
    .poll(() =>
      page
        .locator('.cm-embed-image')
        .evaluateAll((all) =>
          all.every((img) => (img as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true)

  await clickLine(page, 'CHARLIE')
  expect(await caretLine(page)).toContain('CHARLIE')

  await clickLine(page, 'DELTA')
  expect(await caretLine(page)).toContain('DELTA')
})
