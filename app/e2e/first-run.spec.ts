import { expect, test } from '@playwright/test'
import { type Server, serve, vaultWith } from './harness'

/**
 * §02b Screen 3 · EMPTY / FIRST-RUN, which is four lines:
 *
 *     NO NOTES YET.
 *     [N] creates the first one.   ⌘K opens the console.
 *     Point Claude Code at this folder and it writes
 *     straight to disk — you will watch the note appear.
 *
 * Two of them shipped. The two that did not are the ones that say what the
 * product is, on the one screen every new reader is guaranteed to see.
 */
let server: Server

test.beforeAll(async () => {
  server = await serve(vaultWith({}))
})

test.afterAll(() => server?.stop())

test('an empty vault says what the folder is for, not only which keys exist', async ({
  page,
}) => {
  await page.goto(server.url)
  // `main`-scoped: `.empty` is also PaneEmpty's class, and the frame draws six
  // of those in the rails on a vault with nothing in it.
  const empty = page.locator('main .empty')
  await expect(empty).toBeVisible()

  await expect(empty).toContainText('No notes yet.')
  await expect(empty).toContainText('[N] creates the first one.')
  await expect(empty).toContainText('⌘K opens the console.')
  await expect(empty).toContainText(
    'Point Claude Code at this folder and it writes straight to disk',
  )
  await expect(empty).toContainText('you will watch the note appear')
})

test('and the promise it makes is one the app keeps', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.locator('main .empty')).toBeVisible()

  // The line says an agent writing to the folder is watched. So write one from
  // outside the browser, the way the sentence describes, and watch.
  await page.request.put(`${server.url}/api/note/notes/001-from-outside.md`, {
    headers: { 'content-type': 'text/markdown' },
    data: '---\nref: 001\ntitle: From outside\n---\nIt appeared.\n',
  })

  await expect(page.getByRole('button', { name: /From outside/ })).toBeVisible({
    timeout: 5000,
  })

  // And the first-run screen gives way the moment the vault stops being empty:
  // it is the state of the folder that draws it, not a dismissable notice.
  await expect(page.locator('main .empty')).toContainText('No note open.')
  await expect(page.locator('main .empty')).not.toContainText('Point Claude Code')
})
