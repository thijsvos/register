import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02b Screen 7 · AGENT-EDIT-LIVE, which is two lines of status bar:
 *
 *     idle    ● WATCHER LIVE ·        · RENDER 0.70ms · 6 files
 *     agent   ● WATCHER LIVE · +1     · WATCHER +1 4.1ms · 7 files
 *
 * The scene worked and its 100 ms promise is asserted in `budgets.spec.ts`. What
 * was missing is the reading off the bar: the RENDER cell always showed the
 * editor's own last repaint, whoever had caused it.
 */
let server: Server

test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/003-terminal-aesthetics.md': note({
        ref: '003',
        title: 'Terminal aesthetics',
        body: 'One typeface. Two weights.\n',
      }),
    }),
  )
})

test.afterAll(() => server?.stop())

test('Screen 7 says who caused the last render, and by how much', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  const bar = page.locator('footer')
  // Idle: `RENDER 0.70ms`, which is our own last repaint.
  await expect(bar).toContainText(/Render/i)
  await expect(bar).not.toContainText(/Watcher \+/i)

  // An agent writes a note nobody asked for. §02b Screen 7:
  //   agent   ● WATCHER LIVE · +1 · WATCHER +1 4.1ms · 7 files
  writeFileSync(
    join(server.vault, 'notes/004-agent.md'),
    note({ ref: '004', title: 'Written by an agent', body: 'From outside.\n' }),
  )

  await expect(bar).toContainText(/Watcher \+1/i, { timeout: 5000 })
  await expect(bar).toContainText(/2 files/i)
  // The count moved, so the bare delta cell is drawn too — the frame shows it
  // twice and the frame is the source of truth.
  await expect(bar.locator('.cell', { hasText: /^\+1$/ })).toHaveCount(1)

  // And it goes back to being ours the moment we render anything.
  await page.locator('.cm-content').click()
  await page.keyboard.type('x')
  await expect(bar).toContainText(/Render/i)
  await expect(bar).not.toContainText(/Watcher \+/i)
})

test('a write we made ourselves is not reported as an agent', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toContainText('Two weights')

  const bar = page.locator('footer')

  // Creating a note fires a watcher event for a path this tab did not have
  // open. Without the etag being recorded at the moment of the write, that
  // event is indistinguishable from an agent's and the bar announces our own
  // keystroke as somebody else's.
  await page.keyboard.press('Escape')
  await page.keyboard.press('n')
  await expect(page.locator('.cm-content')).toContainText('Untitled note', {
    timeout: 5000,
  })

  await expect(bar).not.toContainText(/Watcher \+/i)
})
