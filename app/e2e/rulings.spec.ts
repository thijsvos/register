import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * Behaviour settled by ruling rather than by a phase.
 *
 * Each of these was an open question in `docs/WORKLIST.md` that the maintainer
 * answered; the entry in `docs/ROADMAP.md` carries the reasoning. They live
 * together because what they have in common is where they came from, not what
 * part of the app they touch.
 */

let server: Server
test.beforeEach(async () => {
  server = await serve(
    vaultWith({
      'notes/001-alpha.md': note({ ref: '001', title: 'Alpha', tags: ['research'] }),
      'notes/002-beta.md': note({
        ref: '002',
        title: 'Beta',
        tags: ['research', 'rust'],
      }),
      // Mentions the word without carrying the tag, which is what separates a
      // tag filter from a search.
      'notes/003-gamma.md': note({
        ref: '003',
        title: 'Gamma',
        body: 'All about research, tagged nothing.\n',
      }),
      // A colon in a plain scalar: the frontmatter does not parse, so the
      // server reports no title and no tags for it.
      'notes/004-broken.md':
        '---\nid: 01J2ZK7Q8W3E5R9T000000004\nref: 004\ntitle: Rust: a survey\ncreated: 2026-08-17\nmodified: 2026-08-17T00:00:00Z\ntags: [design]\n---\nBody.\n',
    }),
  )
})
test.afterEach(async () => await server.stop())

test('NEW · NOTE names the note what you typed', async ({ page }) => {
  // It used to make `Untitled note` and throw the title away, so a titled note
  // could only be cut from a stencil — and a vault with no `templates/` could
  // create nothing else. The row also used to vanish while you typed, because
  // `Launch plan` does not fuzzy-match `NEW · NOTE`.
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('Launch plan')

  const row = page.getByRole('option').filter({ hasText: 'NEW · NOTE' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Launch plan')

  await row.click()
  await expect(page.locator('header.note h2')).toHaveText('Launch plan')

  const tree = await (await page.request.get(`${server.url}/api/tree`)).json()
  const made = tree.notes.find(
    (entry: { title: string }) => entry.title === 'Launch plan',
  )
  expect(made, 'the note was not written with its title').toBeTruthy()
  expect(made.path).toMatch(/launch-plan\.md$/)
})

test('clicking a tag asks the palette for exactly that tag', async ({ page }) => {
  // §02b defines no tag component, so the click hands the question to the
  // surface that already answers it rather than inventing a second browsing
  // mode over the tree.
  await page.goto(server.url)
  await page.getByRole('button', { name: '#research' }).first().click()

  await expect(page.getByRole('combobox')).toHaveValue('tag:research')

  const names = await page.getByRole('option').allInnerTexts()
  const joined = names.join(' ')
  expect(joined).toContain('Alpha')
  expect(joined).toContain('Beta')
  // The note that only *mentions* research is not tagged with it. A plain
  // search would have returned it, which is the difference the filter exists
  // to make.
  expect(joined).not.toContain('Gamma')
})

test('a note whose frontmatter did not parse says so', async ({ page }) => {
  // It degrades to no title and no tags — right, because one bad note must not
  // take the index down — and until now was drawn exactly like a note that
  // simply has no title. Silent, and permanent.
  await page.goto(server.url)
  await page
    .getByRole('button', { name: /broken/i })
    .first()
    .click()
  await expect(page.locator('.cm-content')).toContainText('Body.')

  const said = page.locator('header.note .unreadable')
  await expect(said).toBeVisible()
  await expect(said).toContainText(/frontmatter did not parse/i)

  // And a note that parses says nothing, or the notice is wallpaper.
  await page.getByRole('button', { name: /Alpha/ }).first().click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.locator('header.note .unreadable')).toHaveCount(0)
})

test('an untitled note is not mistaken for an unreadable one', async ({ page }) => {
  // The notice keys on "has a title line, and the server still reports none".
  // A note with no title line at all is ordinary, and must stay quiet.
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('')
  await page.getByRole('option').filter({ hasText: 'NEW · NOTE' }).click()
  await expect(page.locator('header.note h2')).toHaveText('Untitled note')
  await expect(page.locator('header.note .unreadable')).toHaveCount(0)
})

test('a theme change no longer dirties the vault', async ({ page }) => {
  // §04 Rev W. `config.json` is tracked, so every setting in it was a diff —
  // switching to dark made the vault dirty and committing it pushed your theme
  // at whoever you shared it with. The scheme, face and scale describe the
  // machine; the collapsed folders describe the content and still travel.
  await page.goto(server.url)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('INVERT')
  await page.keyboard.press('Enter')

  // The machine's half landed in the ignored file…
  await expect
    .poll(async () => (await page.request.get(`${server.url}/api/local`)).json())
    .toHaveProperty('scheme')

  // …and not in the tracked one.
  const tracked = await (await page.request.get(`${server.url}/api/config`)).json()
  expect(tracked).not.toHaveProperty('scheme')
  expect(tracked).not.toHaveProperty('bodyFace')
  expect(tracked).not.toHaveProperty('scale')
})

test('a vault that predates the split keeps the theme it was given', async ({ page }) => {
  // The migration, and the reason there is no migration step: an upgrade that
  // silently reset everybody's theme would be a worse bug than the one fixed.
  // `config.json` is the fallback until `local.json` carries the key, and the
  // next save moves it across.
  await page.request.put(`${server.url}/api/config`, {
    data: { scheme: 'dark', bodyFace: 'teletype', collapsed: ['notes'] },
    headers: { 'content-type': 'application/json' },
  })
  await page.goto(server.url)

  // Read off the document, which is where the setting actually lands.
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains('teletype')),
    )
    .toBe(true)

  // And the folder fold, which belongs to the vault, survived in the tracked file.
  const tracked = await (await page.request.get(`${server.url}/api/config`)).json()
  expect(tracked.collapsed).toEqual(['notes'])
})

test('a deletion re-asks when the vault moved under the question', async ({ page }) => {
  // §04 Rev X. Every write was etag-guarded and no deletion was, so a note an
  // agent edited between the confirm being drawn and answered was trashed
  // carrying that edit. Re-asking rather than failing is what makes the guard
  // usable: any write bumps the revision, including one of our own.
  await page.goto(server.url)
  await page.getByRole('button', { name: /Alpha/ }).first().click()
  await expect(page.locator('.cm-content')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('DELETE · NOTE')
  await page.keyboard.press('Enter')
  await expect(page.locator('#pal-question')).toContainText('001-alpha.md')

  // An agent writes while the question is on screen — and the wait matters. The
  // revision moves in exactly one place, `Vault::changed`, which the *watcher*
  // calls: one change is one bump whoever made it, so the write path deliberately
  // does not move it. Answering before the watcher has reported would carry a
  // revision the server has not left behind yet and would rightly succeed.
  // Waiting for the row to appear is waiting for the vault to have moved.
  await page.request.put(`${server.url}/api/note/notes/009-agent.md`, {
    data: '---\nref: 009\ntitle: Agent wrote this\n---\nBody.\n',
    headers: { 'content-type': 'text/markdown' },
  })
  await expect(page.getByRole('button', { name: /Agent wrote this/ })).toBeVisible()

  await page.keyboard.press('Enter')

  // Asked again rather than refused, and the note is still there.
  await expect(page.locator('#pal-question')).toContainText('001-alpha.md')
  await expect(page.locator('footer')).toContainText(/vault changed/i)
  const still = await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)
  expect(still.status()).toBe(200)

  // Answering the re-asked question deletes it. Waiting for the answer to take
  // focus first, which is what a reader does — they see the question before they
  // answer it, and the re-arm has a render to get through. Pressing straight
  // through it raced the focus on WebKit and the key went nowhere.
  await expect(page.locator('.row.answer').first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect
    .poll(async () =>
      (await page.request.get(`${server.url}/api/note/notes/001-alpha.md`)).status(),
    )
    .toBe(404)
})
