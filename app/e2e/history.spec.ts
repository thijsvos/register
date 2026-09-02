import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02b Screen 11 · HISTORY, over a vault whose history was written by hand
 * exactly the way `src/git.rs` writes it: checkpoints carrying `You:` and
 * `Outside:` trailers. The checkpointer itself wants ninety seconds of quiet,
 * which is not a thing a test waits for; `src/git/tests.rs` proves it writes
 * what this fixture contains, and this proves what the screen does with it.
 */

function git(vault: string, ...args: string[]): void {
  execFileSync('git', ['-C', vault, ...args], { stdio: 'pipe' })
}

const FIRST = note({ ref: '001', title: 'Alpha', body: 'The first body.\n' })
const SECOND = note({
  ref: '001',
  title: 'Alpha',
  body: 'The first body.\nA line an agent added.\n',
})

let server: Server
test.beforeEach(async () => {
  const vault = vaultWith({
    'notes/001-alpha.md': FIRST,
    'notes/002-beta.md': note({ ref: '002', title: 'Beta' }),
  })
  git(vault, 'init', '--quiet')
  git(vault, 'config', 'user.email', 't@e')
  git(vault, 'config', 'user.name', 'T')
  git(vault, 'add', '-A')
  git(
    vault,
    'commit',
    '--quiet',
    '--cleanup=verbatim',
    '-m',
    'checkpoint: 09:00Z · 2 you\n\nYou: notes/001-alpha.md\nYou: notes/002-beta.md\n',
  )
  // Then an agent rewrote Alpha, and the next checkpoint said so.
  writeFileSync(join(vault, 'notes/001-alpha.md'), SECOND)
  git(vault, 'add', '-A')
  git(
    vault,
    'commit',
    '--quiet',
    '--cleanup=verbatim',
    '-m',
    'checkpoint: 09:05Z · 1 outside\n\nOutside: notes/001-alpha.md\n',
  )
  server = await serve(vault)
})
test.afterEach(async () => await server.stop())

/**
 * From the INDEX row, not the palette: with the search index still warming on
 * a loaded machine, Enter on `Alpha` can land on NEW · NOTE and make a second
 * one — measured once in the full suite — and this spec is about the note that
 * already exists.
 */
async function openAlpha(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^001 Alpha/ }).click()
  await expect(page.locator('.cm-content')).toContainText('The first body.')
}

test('the status bar counts what landed outside since your last save', async ({
  page,
}) => {
  // The thing this screen exists for: you were not watching, and nothing on
  // screen used to say so.
  await page.goto(server.url)
  await expect(page.locator('footer')).toContainText('1 outside')
})

test('a note has a history, a version reads against now, and R puts it back', async ({
  page,
}) => {
  await page.goto(server.url)
  await openAlpha(page)
  // Out of the editor, where `g h` would be two letters.
  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await page.keyboard.press('h')

  await expect(page.locator('.history h2')).toHaveText('001-alpha.md')
  const rows = page.locator('.history .row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('outside')
  await expect(rows.nth(1)).toContainText('you')

  // The older version, against the note as it is now.
  await rows.nth(1).click()
  await expect(page.locator('.history .line')).not.toHaveCount(0)
  await expect(page.locator('.history .gate')).toContainText('1 line differs')

  await page.keyboard.press('r')
  await expect(page.locator('footer')).toContainText('Restored')
  // Back on the note, reading the first body; the count is gone, because a
  // save through the app is the newest word.
  await expect(page.locator('.cm-content')).toContainText('The first body.')
  await expect(page.locator('.cm-content')).not.toContainText('an agent added')
  await expect(page.locator('footer')).not.toContainText('outside')
  // And on disk, through the same guarded PUT as any save.
  const body = await (
    await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)
  ).text()
  expect(body).toContain('The first body.\n')
  expect(body).not.toContain('an agent added')
})

test('the ledger lists the vault newest first, and Escape steps out', async ({
  page,
}) => {
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('GO · LEDGER')
  await page.getByRole('option').filter({ hasText: 'GO · LEDGER' }).first().click()

  await expect(page.locator('.history h2')).toHaveText('Ledger')
  const rows = page.locator('.history .row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('notes/001-alpha.md')
  await expect(rows.nth(0)).toContainText('outside')
  await expect(rows.nth(2)).toContainText('you')

  // Into a version, then one Escape back to the list, then one out.
  await rows.nth(0).click()
  await expect(page.locator('.history .heads')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.history .row')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(page.locator('.history')).toHaveCount(0)
})
