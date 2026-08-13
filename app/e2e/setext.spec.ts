import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * A title underlined with `===` is a heading, on the page and in the pane.
 *
 * The grammar has always reported these; nothing asked it. The two halves are
 * tested together on purpose — the outline listing a heading the editor draws as
 * plain prose is the disagreement the old comment in `outline.ts` was avoiding
 * by leaving both out.
 */

let server: Server
test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/001-setext.md': note({
        ref: '001',
        title: 'Setext',
        body: [
          'Terminal aesthetics',
          '===================',
          '',
          'Some prose about it.',
          '',
          'Hairlines',
          '---------',
          '',
          'More prose.',
          '',
          '---',
          '',
          'Prose after a rule, which is not a heading.',
          '',
        ].join('\n'),
      }),
    }),
  )
})
test.afterAll(async () => await server.stop())

test('the page styles both underlined titles', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Setext/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  await expect(page.locator('.cm-h1', { hasText: 'Terminal aesthetics' })).toHaveCount(1)
  await expect(page.locator('.cm-h2', { hasText: 'Hairlines' })).toHaveCount(1)

  // Bigger than the prose around it, which is the whole point of styling it.
  const heading = await page
    .locator('.cm-h1', { hasText: 'Terminal aesthetics' })
    .evaluate((n) => Number.parseFloat(getComputedStyle(n).fontSize))
  const prose = await page
    .locator('.cm-line', { hasText: 'Some prose about it' })
    .first()
    .evaluate((n) => Number.parseFloat(getComputedStyle(n).fontSize))
  expect(heading).toBeGreaterThan(prose)
})

test('the pane lists them beside the ATX ones', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Setext/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  const pane = page.locator('[aria-label="Inspector"]')
  await expect(pane.getByRole('button', { name: 'Terminal aesthetics' })).toBeVisible()
  await expect(pane.getByRole('button', { name: 'Hairlines' })).toBeVisible()
})

test('a horizontal rule is still a horizontal rule', async ({ page }) => {
  // `---` under a paragraph is a heading and `---` after a blank line is a rule.
  // Reading that wrong would put every rule in the vault into the outline.
  await page.goto(server.url)
  await page.getByRole('button', { name: /Setext/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  const pane = page.locator('[aria-label="Inspector"]')
  await expect(pane.getByRole('button', { name: /Prose after a rule/ })).toHaveCount(0)
  await expect(pane.getByRole('button', { name: /More prose/ })).toHaveCount(0)
})

test('clicking one lands on the title, not on the underline', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Setext/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  await page
    .locator('[aria-label="Inspector"]')
    .getByRole('button', { name: 'Hairlines' })
    .click()
  const line = await page.evaluate(() => {
    const node = window.getSelection()?.anchorNode
    const el = node instanceof Element ? node : (node?.parentElement ?? null)
    return el?.closest('.cm-line')?.textContent ?? '(none)'
  })
  expect(line).toContain('Hairlines')
})
