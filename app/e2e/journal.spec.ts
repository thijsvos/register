import { expect, type Page, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02b Screen 1: the journal in the INDEX.
 *
 * It was hidden because there is one log per day forever and `daily/` sorts
 * before `notes/`, so a year of dated rows sat above everything you wrote —
 * true of a flat list, and not true of a folder that starts shut. What these
 * pin is that it costs one row until asked, that the dates are readable, and
 * that a log written by an older build still shows the right date.
 */

const day = (date: string, title = date) =>
  note({ ref: '000', title, body: `Wrote something on ${date}.\n` }).replace(
    /^ref: 000\n/m,
    '',
  )

let server: Server
test.beforeEach(async () => {
  server = await serve(
    vaultWith({
      'notes/001-alpha.md': note({ ref: '001', title: 'Alpha' }),
      'daily/2026-08-10.md': day('2026-08-10'),
      'daily/2026-08-11.md': day('2026-08-11', 'TEMPLATE'),
      'daily/2026-08-12.md': day('2026-08-12'),
    }),
  )
})
test.afterEach(async () => await server.stop())

const rows = (page: Page) =>
  page
    .locator('[aria-label="Index"] nav button')
    .allInnerTexts()
    .then((all) => all.map((text) => text.replace(/\s+/g, ' ').trim()))

test('the journal is one row until you ask for it', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('button', { name: /Alpha/ })).toBeVisible()

  const shown = await rows(page)
  expect(shown).toContain('▸ DAILY 3')
  // Three logs, and none of them taking a row.
  expect(shown.some((row) => row.includes('2026-08'))).toBe(false)
})

test('opening it shows the dates, newest first, with the weekday', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /daily/i }).click()

  const shown = await rows(page)
  const dated = shown.filter((row) => row.includes('2026-08'))
  expect(dated).toEqual(['WED 2026-08-12 4', 'TUE 2026-08-11 4', 'MON 2026-08-10 4'])
})

test('a log the old build mis-titled still shows its real date', async ({ page }) => {
  // 2026-08-11 is titled TEMPLATE in the fixture, which is what an older build
  // actually wrote. The row reads the filename, which §04 fixes.
  await page.goto(server.url)
  await page.getByRole('button', { name: /daily/i }).click()

  await expect(page.getByRole('button', { name: /2026-08-11/ })).toBeVisible()
  expect((await rows(page)).some((row) => row.includes('TEMPLATE'))).toBe(false)
})

test('opening one puts you in that day', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /daily/i }).click()
  await page.getByRole('button', { name: /2026-08-10/ }).click()

  await expect(page.locator('.cm-content')).toContainText('Wrote something on 2026-08-10')
  await expect(page.locator('header .crumb')).toContainText('2026-08-10')
})

test('having opened it, it stays open across a reload', async ({ page }) => {
  // The mirror of every other folder: what the reader chose is what is stored.
  await page.goto(server.url)
  await page.getByRole('button', { name: /daily/i }).click()
  await expect(page.getByRole('button', { name: /2026-08-12/ })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: /2026-08-12/ })).toBeVisible()

  await page.getByRole('button', { name: /daily/i }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: /2026-08-12/ })).toHaveCount(0)
})

test('the file count still counts notes, not days', async ({ page }) => {
  // Drawn is not the same question as "is this a note you filed". The journal
  // is drawn; the status bar counts what you wrote.
  await page.goto(server.url)
  await expect(page.locator('footer')).toContainText('1')
  await expect(page.locator('[aria-label="Index"]')).toContainText('[1]')
})

test('⌘D opens today, and the palette says so', async ({ page }) => {
  // Rev T. §08 P7 always read "⌘D / GO DAILY"; §02b Screen 2 drew the key
  // against GO · TODAY / TASKS and the build followed the frame, so for four
  // months a whole modifier reached a view `G T` already reached while the note
  // you open every morning had only the chord.
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+d')

  // Today's log, which the fixture does not contain — so this also pins that
  // the key creates the day rather than failing on a note that is not there.
  const today = new Date().toISOString().slice(0, 10)
  await expect(page.locator('header .crumb')).toContainText(today)
  await expect(page.locator('.cm-content')).toBeVisible()

  // And the two rows carry the keys the ruling gave them, because §01 asks a
  // control to show its key and a swap the palette did not follow would be
  // worse than no swap at all.
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog')
  const row = (label: string) => palette.getByRole('option').filter({ hasText: label })
  await expect(row('GO · DAILY LOG')).toContainText('⌘D')
  await expect(row('GO · TODAY / TASKS')).toContainText('G T')
})
