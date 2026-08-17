import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * The README's screenshots, as code.
 *
 * Not part of the suite — `playwright.config.ts` ignores this file and
 * `pnpm shots` runs it on purpose. It asserts almost nothing; what it produces
 * is two PNGs.
 *
 * It exists because the pictures in a README rot silently. The pair it replaced
 * were captured by hand in August and were still being shipped after the frame
 * had gained two screens, moved a keybinding and changed its reading measure —
 * a reader comparing them against the running app would have concluded the
 * project was something else. Anything regenerable should be regenerated.
 *
 * The vault below is written to be *representative* rather than pretty: real
 * frontmatter, a folder tree deep enough to need the crumb, tags with different
 * counts so the meters differ, wikilinks that resolve and one that does not,
 * inline code, a task list, and a daily log — so every pane in the frame has
 * something true in it.
 */

const SHOTS = join(process.cwd(), '..', 'docs')

/**
 * A readable path for the VAULT field.
 *
 * `vaultWith` makes an `mkdtemp` directory, which is right for a test and wrong
 * for a picture: the status bar drew
 * `/PRIVATE/VAR/FOLDERS/19/20X2CCXN…/T/REGISTER-E2E-2LDX` across a third of the
 * frame, which tells a reader nothing except that this was staged. `tmpdir()`
 * is barely better on macOS, where it *is* that path — so this is spelled out.
 * The server canonicalises it, so the field reads `/PRIVATE/TMP/VAULT`.
 */
const VAULT = '/tmp/vault'

let server: Server

test.beforeAll(async () => {
  rmSync(VAULT, { recursive: true, force: true })
  mkdirSync(VAULT, { recursive: true })
  const staged = vaultWith({
    'CLAUDE.md': '# vault contract\n',
    'notes/003-terminal-aesthetics.md': note({
      ref: '003',
      title: 'Terminal aesthetics',
      tags: ['design', 'doctrine', 'type'],
      body: [
        'The frame is an instrument, not a document. Every field on screen is',
        'either measured or derived — nothing is decorative and nothing is',
        'invented.',
        '',
        '## Ink',
        '',
        'One ink, tuned per surface. `--fg` is demoted from full white because',
        'a monochrome frame at maximum contrast reads as a warning, not as a',
        'page. The single accent marks the live edge of the system: where you',
        'are, and what changed under you.',
        '',
        '## Measure',
        '',
        'Prose is capped at 68 characters and is never full-bleed. See',
        '[[Design doctrine]] for why the rails widen and the column does not,',
        'and [[Perf doctrine]] for what that costs.',
        '',
        '## Open',
        '',
        '- [x] Decide what the accent is for',
        '- [ ] Re-measure the rails on a 5K panel',
        '- [ ] Answer [[Colour on a projector]]',
      ].join('\n'),
    }),
    'notes/004-design-doctrine.md': note({
      ref: '004',
      title: 'Design doctrine',
      tags: ['design', 'doctrine'],
      body: 'Hairlines, inverse video, no glow. See [[Terminal aesthetics]].\n',
    }),
    'notes/005-perf-doctrine.md': note({
      ref: '005',
      title: 'Perf doctrine',
      tags: ['doctrine', 'perf'],
      body: 'Latency is a material. 16 ms, and the status bar shows it.\n',
    }),
    'notes/projects/010-launch-plan.md': note({
      ref: '010',
      title: 'Launch plan',
      tags: ['perf'],
      body: 'Cut the release, then the container. See [[Perf doctrine]].\n',
    }),
    'notes/projects/apollo/011-retrospective.md': note({
      ref: '011',
      title: 'Retrospective',
      tags: ['design'],
      body: 'What the frame taught us.\n',
    }),
    'daily/2026-08-17.md': note({
      ref: '000',
      title: '2026-08-17',
      tags: ['daily'],
      body: '## Log\n\nRuled on the whole worklist.\n\n## Tasks\n\n- [ ] Cut 0.7.0\n',
    }).replace(/^ref: 000\n/m, ''),
    'templates/daily.md': note({ ref: '000', title: 'TEMPLATE', tags: ['daily'] }),
  })
  cpSync(staged, VAULT, { recursive: true })
  server = await serve(VAULT)

  // A repository, so the status bar's GIT field says something real rather than
  // drawing the dash it shows for a folder that is not one.
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', server.vault, ...args], { stdio: 'ignore' })
  git('init', '--quiet')
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  git('config', 'user.email', 'shots@register.invalid')
  git('config', 'user.name', 'register')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'vault: initial')
  // One unstaged edit, so GIT reads `MAIN ~1` — a clean vault says only `MAIN`,
  // and a screenshot of that teaches nothing about what the field is for.
  execFileSync('sh', [
    '-c',
    `printf '\\nOne more line.\\n' >> ${server.vault}/notes/005-perf-doctrine.md`,
  ])
})

test.afterAll(async () => await server.stop())

/** Open the note the shots are of, with the panes in their default state. */
async function frame(page: Page): Promise<void> {
  await page.goto(server.url)
  await page
    .getByRole('button', { name: /Terminal aesthetics/ })
    .first()
    .click()
  await expect(page.locator('.cm-content')).toContainText('The frame is an instrument')
  // Put the caret where a reader would leave it and let the render settle, so
  // the RENDER field has a number in it rather than an em dash.
  await page.locator('.cm-content').click()
  await expect(page.locator('footer')).toContainText('Git')
}

test('the frame, light and dark', async ({ page }) => {
  await frame(page)

  // Light first, and explicitly rather than by default: the shot must not
  // depend on whatever `prefers-color-scheme` the machine taking it happens to
  // report.
  await page.emulateMedia({ colorScheme: 'light' })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(false)
  await page.screenshot({ path: join(SHOTS, 'screenshot.png') })

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(true)
  await page.screenshot({ path: join(SHOTS, 'screenshot-dark.png') })

  // The trash, in the same flow rather than a second test: a fresh test gets a
  // fresh page against the same server, and the first attempt at that drew an
  // empty frame — every field reading an em dash — because the shot was taken
  // before the new page had a tree. One flow, one server, one settled frame.
  await page.request.delete(`${server.url}/api/note/notes/004-design-doctrine.md`)
  await page.request.delete(`${server.url}/api/folder/notes/projects/apollo`)
  await expect(page.getByRole('button', { name: /Design doctrine/ })).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('GO · TRASH')
  await page.getByRole('option').filter({ hasText: 'GO · TRASH' }).first().click()
  await expect(page.locator('.trash h2')).toHaveText('Trash')
  // Wait for the rows themselves: the screen says "Reading." until the buckets
  // land, and a picture of that is a picture of nothing.
  await expect(page.locator('.trash .rows li')).toHaveCount(2)
  await page.screenshot({ path: join(SHOTS, 'screenshot-trash.png') })
})
