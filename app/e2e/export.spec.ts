import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import { exportVault, note, serve, vaultWith } from './harness'

/**
 * The export (§12, ADR-008): a vault and its reader as one file, opened from
 * disk with no server behind it.
 *
 * Every claim the README makes for it is asserted here against the real
 * binary's output in a real browser — that it opens with no network at all,
 * that search, links, backlinks and TODAY all work, that nothing writes, and
 * that it fits its §06 budgets. The no-network claim is the one that matters
 * most and it is checked the only honest way: every request the page makes is
 * recorded, and anything that is not the file itself fails the test.
 */

/** The repository's own screenshot: a PNG that is definitely a PNG. */
const PNG = readFileSync(join(process.cwd(), '..', 'docs', 'screenshot.png'))

/** The same scale `budgets.spec.ts` applies, for the same reason. */
const SLOW = Number(process.env.BUDGET_FACTOR ?? (process.env.CI ? '2.5' : '1'))

let file: string
let url: string

test.beforeAll(() => {
  const vault = vaultWith({
    'notes/003-alpha.md': note({
      ref: '003',
      title: 'Alpha',
      tags: ['seed'],
      body: [
        '# Alpha',
        '',
        'A paragraph with the word quokka in it.',
        '',
        'See [[Beta]], and [[Missing]] which is not here.',
        '',
        '![diagram](diagram.png)',
        '',
        '- [ ] water the plants',
        '',
      ].join('\n'),
    }),
    'notes/004-beta.md': note({
      ref: '004',
      title: 'Beta',
      body: '# Beta\n\nThe far side.\n\n- [ ] file the report\n',
    }),
    'notes/diagram.png': PNG,
  })
  file = exportVault(vault)
  url = pathToFileURL(file).href
})

/** Open the export and wait for the frame. */
async function open(page: Page): Promise<void> {
  await page.goto(url)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()
}

/** Open a note through ⌘K, the way §01 says you can. */
async function openNote(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill(title)
  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-content')).toBeVisible()
}

test('opens from disk, asks nothing of anyone, and says what it is', async ({ page }) => {
  const reached: string[] = []
  const violations: string[] = []
  const thrown: string[] = []
  page.on('request', (request) => {
    if (!/^(?:file|data|blob):/.test(request.url())) reached.push(request.url())
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy/i.test(message.text())) {
      violations.push(message.text())
    }
  })
  page.on('pageerror', (error) => thrown.push(String(error.message)))

  await open(page)
  await openNote(page, 'Alpha')
  await expect(page.locator('.cm-content')).toContainText('quokka')
  // Long enough for a corpus fill, a font swap or a stray beacon to show.
  await page.waitForTimeout(600)

  expect(reached, `the export reached the network:\n${reached.join('\n')}`).toEqual([])
  expect(
    violations,
    `the export violates its own policy:\n${violations.join('\n')}`,
  ).toEqual([])
  expect(thrown, `uncaught in the export:\n${thrown.join('\n')}`).toEqual([])

  // The status bar says what this is — and not what it is not.
  const bar = page.locator('footer')
  await expect(bar).toContainText(/Export/i)
  await expect(bar).toContainText(/\d{4}-\d\d-\d\d \d\d:\d\dZ/)
  await expect(bar).not.toContainText(/Watcher/i)
  await expect(bar).not.toContainText(/Git/i)
  // And the vault by its name, never by where it lived: the folder is called
  // `register-e2e-…`, and that is what the VAULT cell may say — not the
  // directory it was made in.
  await expect(bar).toContainText(/Vault\s+register-e2e-/i)
  await expect(bar).not.toContainText(tmpdir())
})

test('⌘K searches the corpus, not a list of titles', async ({ page }) => {
  await open(page)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command and search' })
  await expect(palette).toBeVisible()

  // "quokka" is in a body and in no title: only a full-text index finds it.
  await page.getByRole('combobox').fill('quokka')
  await expect(palette.getByRole('option').first()).toContainText('Alpha')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('quokka')
})

test('a wikilink navigates, and the backlinks pane answers', async ({ page }) => {
  await open(page)
  await openNote(page, 'Alpha')

  await page.locator('.cm-content [role="link"]', { hasText: 'Beta' }).click()
  await expect(page.locator('.cm-content')).toContainText('The far side.')

  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector).toContainText('Alpha')
})

test('a link to a note the export does not hold says so rather than creating it', async ({
  page,
}) => {
  await open(page)
  await openNote(page, 'Alpha')
  await page.locator('.cm-content [role="link"]', { hasText: 'Missing' }).click()

  await expect(page.getByRole('status')).toContainText(/No note called Missing/i)
  // Still on Alpha: nothing was made, and nothing moved.
  await expect(page.locator('.cm-content')).toContainText('quokka')
})

test('TODAY lists tasks from across the vault', async ({ page }) => {
  await open(page)
  await page.keyboard.press('g')
  await page.keyboard.press('t')
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  await expect(page.getByText('water the plants')).toBeVisible()
  await expect(page.getByText('file the report')).toBeVisible()
})

test('the image travelled, as data', async ({ page }) => {
  await open(page)
  await openNote(page, 'Alpha')

  const image = page.locator('.cm-embed-image')
  await expect(image).toHaveCount(1)
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)
  // Decoded, not merely present.
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
})

test('--media none leaves the reference drawn as missing', async ({ page }) => {
  const lean = exportVault(
    vaultWith({
      'notes/003-alpha.md': note({
        ref: '003',
        title: 'Alpha',
        body: '![diagram](diagram.png)\n',
      }),
      'notes/diagram.png': PNG,
    }),
    '--media',
    'none',
  )
  await page.goto(pathToFileURL(lean).href)
  await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()
  await openNote(page, 'Alpha')

  // The same state a served page draws for a file the vault never had, known
  // here before anything was tried.
  await expect(page.locator('.cm-embed-missing')).toHaveCount(1)
  await expect(page.locator('.cm-embed-image')).toHaveCount(0)
  expect(statSync(lean).size).toBeLessThan(statSync(file).size)
})

test('nothing writes', async ({ page }) => {
  await open(page)
  await openNote(page, 'Alpha')

  // A reading surface: no caret to type into.
  const content = page.locator('.cm-content')
  await expect(content).toHaveAttribute('contenteditable', 'false')
  const before = await content.textContent()
  // The first line, not the middle of the note: the middle is the embedded
  // image, and clicking that raises Screen 8.
  await content.click({ position: { x: 8, y: 8 } })
  await page.keyboard.type('zzz')
  expect(await content.textContent()).toBe(before)

  // The task box is drawn and stays as it is.
  const box = page.getByRole('checkbox').first()
  await expect(box).toHaveAttribute('aria-checked', 'false')
  await box.click()
  await expect(box).toHaveAttribute('aria-checked', 'false')

  // N — the key a reader knows — answers rather than doing nothing.
  await page.keyboard.press('Escape')
  await page.keyboard.press('n')
  await expect(page.getByRole('status')).toContainText(/read-only/i)

  // And the palette offers no way to write.
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command and search' })
  await expect(palette).toBeVisible()
  for (const label of ['NEW · NOTE', 'MOVE · NOTE', 'DELETE', 'GO · TRASH', 'RESOLVE']) {
    await expect(palette.getByRole('option', { name: new RegExp(label) })).toHaveCount(0)
  }
  await expect(palette.getByRole('option', { name: /TOGGLE INSPECTOR/ })).toHaveCount(1)
})

test('both schemes paint, and the choice holds for the page', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await open(page)
  expect(
    await page.evaluate(() => document.documentElement.classList.contains('dark')),
  ).toBe(true)
  // INV flips it in memory; an export holds that for the page and writes it
  // nowhere, which is what Screen 6 says of itself here.
  await page.keyboard.press('i')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(false)
})

// ------------------------------------------------------------------ §06 budgets

test('open → readable in under 500 ms', async ({ page, browserName }) => {
  test.skip(
    browserName !== 'chromium',
    'the §06 latency budgets are stated against one engine; see ROADMAP',
  )
  const started = Date.now()
  await page.goto(url)
  await page.getByRole('button', { name: /Alpha/ }).click()
  await expect(page.locator('.cm-content')).toContainText('quokka')
  const took = Date.now() - started

  const limit = 500 * SLOW
  expect(
    took,
    `open → readable — §06 allows 500 ms × ${SLOW}; took ${took} ms`,
  ).toBeLessThan(limit)
})

test('the chrome alone is under 800 kB, and a 1k-note vault under 8 MB', () => {
  // The chrome: the UI and its faces, no notes. What a one-line export costs.
  const chrome = exportVault(vaultWith({}))
  const chromeBytes = statSync(chrome).size
  expect(
    chromeBytes,
    `the chrome is ${chromeBytes} bytes — §06 allows 800 kB`,
  ).toBeLessThan(800_000)

  const notes: Record<string, string> = {}
  for (let n = 0; n < 1000; n++) {
    const ref = String(n).padStart(4, '0')
    notes[`notes/${ref}-note.md`] = note({
      ref,
      title: `Note ${ref}`,
      tags: ['bulk'],
      body: `# Note ${ref}\n\nParagraph one of note ${ref}.\n\n- [ ] task ${ref}\n`,
    })
  }
  const big = exportVault(vaultWith(notes), '--media', 'none')
  const bigBytes = statSync(big).size
  expect(
    bigBytes,
    `a 1k-note export is ${bigBytes} bytes — §06 allows 8 MB`,
  ).toBeLessThan(8_000_000)
})

// -------------------------------------------------------- from the page (§12)

test('⌘K exports the vault from a served page, and the file is the same export', async ({
  page,
  browserName,
}) => {
  // The route is `GET /api/export` with `Content-Disposition: attachment`, and
  // the palette follows it with a `download` anchor — so the page stays, and
  // the browser's own download is the proof. Chromium only: Firefox and WebKit
  // under automation each need their own download-directory plumbing, and the
  // route's headers are asserted by `src/server/tests.rs` on every engine's
  // behalf.
  test.skip(browserName !== 'chromium', 'download capture is set up for one engine')

  const server = await serve(
    vaultWith({
      'notes/003-alpha.md': note({
        ref: '003',
        title: 'Alpha',
        body: 'A paragraph with the word zebrafish in it.\n',
      }),
    }),
  )
  try {
    await page.goto(server.url)
    await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

    const waiting = page.waitForEvent('download')
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('combobox').fill('export')
    await expect(
      page
        .getByRole('dialog', { name: 'Command and search' })
        .getByRole('option')
        .first(),
    ).toContainText('EXPORT · VAULT AS HTML')
    await page.keyboard.press('Enter')

    const download = await waiting
    // Named by the server: the vault's folder and the date, never its path.
    expect(download.suggestedFilename()).toMatch(
      /^register-e2e-[^/]+-\d{4}-\d\d-\d\d\.html$/,
    )
    await expect(page.getByRole('status')).toContainText(/Exporting/i)
    // And the page is still the page: the socket was not torn down.
    await expect(page.locator('footer')).toContainText(/Watcher\s+Live/i)

    // What came down opens as an export does.
    const saved = join(dirname(file), download.suggestedFilename())
    await download.saveAs(saved)
    await page.goto(pathToFileURL(saved).href)
    await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()
    await expect(page.locator('footer')).toContainText(/Export/i)
    await openNote(page, 'Alpha')
    await expect(page.locator('.cm-content')).toContainText('zebrafish')
  } finally {
    server.stop()
  }
})
