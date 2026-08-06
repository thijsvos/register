import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { msUntilVisible, note, rss, type Server, serve, vaultWith } from './harness'

/**
 * §06's budgets, measured against the real binary (§08 P11).
 *
 * "Budgets are law. If a change breaks a budget, shrink the change, not the
 * budget." These are the numbers, so they are asserted rather than reported.
 */
let server: Server

/** §06: idle RAM is budgeted for a 1k-note vault, so that is the vault. */
const NOTES = 1000

test.beforeAll(async () => {
  const notes: Record<string, string> = {}
  for (let n = 0; n < NOTES; n++) {
    const ref = String(n).padStart(4, '0')
    notes[`notes/${ref}-note.md`] = note({
      ref,
      title: `Note ${ref}`,
      tags: ['bulk'],
      body: `# Note ${ref}\n\nParagraph one of note ${ref}.\n\n- [ ] task ${ref}\n`,
    })
  }
  server = await serve(vaultWith(notes))
})

test.afterAll(() => server?.stop())

test('server start → editable in under 500 ms', async ({ page }) => {
  const started = Date.now()
  await page.goto(server.url)
  // Editable means a note is open and takes keystrokes, not merely that
  // something painted.
  await page.getByRole('button', { name: /Note 0007/ }).click()
  await expect(page.locator('.cm-content')).toBeFocused()
  const took = Date.now() - started

  expect(took, `start → editable took ${took} ms`).toBeLessThan(500)
})

test('a document switch costs under 16 ms', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Note 0007/ }).click()
  await expect(page.locator('.cm-content')).toContainText('note 0007')

  // §06 measures this with "the status-bar RENDER readout + Playwright
  // assertion", so both: the app's own number, and the observed swap.
  const swaps: number[] = []
  for (const ref of ['0011', '0042', '0300', '0777']) {
    // Armed, clicked and observed in one round trip. Splitting it deadlocks:
    // a pending `evaluate` and a `click` do not interleave on one page, so the
    // observer waits for a click that is waiting for the observer.
    swaps.push(
      await page.evaluate(
        ({ label, needle }) =>
          new Promise<number>((resolve) => {
            // Observed on <body>, not on `.cm-content`: switching notes can
            // replace that element, and an observer bound to the old one never
            // fires again.
            const hit = () =>
              (document.querySelector('.cm-content')?.textContent ?? '').includes(needle)
            const started = performance.now()
            if (hit()) return resolve(0)

            const observer = new MutationObserver(() => {
              if (!hit()) return
              observer.disconnect()
              resolve(performance.now() - started)
            })
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
            })

            const row = [...document.querySelectorAll('button')].find((button) =>
              (button.textContent ?? '').includes(label),
            )
            row?.click()
          }),
        { label: `Note ${ref}`, needle: `note ${ref}` },
      ),
    )

    const readout = await page.getByText(/ms$/).first().textContent()
    const rendered = Number((readout ?? '').replace('ms', ''))
    expect(rendered, `RENDER read ${readout} on switching to ${ref}`).toBeLessThan(16)
  }

  // The observed swap includes one network round trip for the note's body,
  // which the 16 ms render budget does not cover — held separately so a switch
  // that renders instantly and then stalls on I/O still fails.
  const worst = Math.max(...swaps)
  expect(worst, `worst observed switch was ${worst.toFixed(0)} ms`).toBeLessThan(100)
})

test('an agent edit is on screen within 100 ms', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Note 0007/ }).click()
  await expect(page.locator('.cm-content')).toContainText('note 0007')

  const marker = 'AGENTWROTETHIS'
  const took = await msUntilVisible(page, marker, () => {
    appendFileSync(join(server.vault, 'notes/0007-note.md'), `\n${marker}\n`)
  })

  // §06: "Agent edit → visible in UI ≤ 100 ms". The watcher debounces 50 ms of
  // that on purpose, so this has about half the budget of headroom.
  expect(took, `agent edit → paint took ${took.toFixed(0)} ms`).toBeLessThanOrEqual(100)
})

test('idle RSS stays under 50 MB on a 1k-note vault', async ({ page }) => {
  await page.goto(server.url)
  // Everything the UI asks for at boot: the tree, then every body behind it.
  await expect(page.getByRole('button', { name: /Note 0999/ })).toBeVisible()
  await page.getByRole('button', { name: /Note 0007/ }).click()
  await expect(page.locator('.cm-content')).toContainText('note 0007')

  // Idle means idle: let the corpus fill finish and the allocator settle.
  await page.waitForTimeout(3000)

  const bytes = rss(server.pid)
  const mb = bytes / 1024 / 1024
  expect(mb, `idle RSS was ${mb.toFixed(1)} MB`).toBeLessThanOrEqual(50)
})

test('the palette opens on a 1k-note vault without a pause', async ({ page }) => {
  // The precondition — a thousand bodies fetched — is slower than a default
  // test timeout on a small runner. The assertions themselves are instant.
  test.setTimeout(120_000)
  await page.goto(server.url)
  await expect(page.getByRole('button', { name: /Note 0999/ })).toBeVisible()

  // Wait for the condition, not for a duration. A thousand bodies arrive three
  // at a time — the browser allows six connections and the user needs some —
  // so a fixed 2 s was enough on a laptop and not on a two-core runner. How
  // long the fill takes has no budget in §06; that ⌘K is instant once it is
  // warm does, and conflating them made this fail for the wrong reason.
  //
  // Opened once and left open: ⌘K toggles, so pressing it inside the poll
  // closes the thing being polled.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Command and search' })).toBeVisible()
  await expect
    .poll(
      async () => {
        // Cleared first so the query genuinely changes and the derived re-runs.
        await page.getByRole('combobox').fill('')
        await page.getByRole('combobox').fill('Paragraph 0500')
        return await page.getByRole('option').count()
      },
      { timeout: 60_000, message: 'the search index never covered the corpus' },
    )
    .toBeGreaterThan(0)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Command and search' })).toBeHidden()

  // Warm, so this measures opening rather than indexing.
  const started = Date.now()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Command and search' })).toBeVisible()
  const took = Date.now() - started

  expect(took, `⌘K took ${took} ms to open`).toBeLessThan(250)

  // And it searches bodies, not just the titles the tree already carries.
  await page.getByRole('combobox').fill('Paragraph 0500')
  await expect(page.getByRole('option').first()).toContainText('Note 0500')
})
