import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §02b Screen 4 · CONFLICT, against the real binary.
 *
 * This is §02b Screen 7's headline demo with its failure mode attached: an agent
 * writes the note you are typing in. Everything up to the conflict copy shipped
 * in P3 and had no end-to-end coverage at all — the whole guarantee rested on a
 * stubbed `fetch` in `store.test.ts`, so nothing proved that a real 409 from a
 * real `vault.rs` reaches a screen a person can act on.
 *
 * A server per test: each one has to start from a vault with no conflict in it,
 * and the copies are named from the clock.
 */
const NOTE = 'notes/003-terminal-aesthetics.md'

function vault(): Record<string, string> {
  return {
    [NOTE]: note({
      ref: '003',
      title: 'Terminal aesthetics',
      tags: ['design'],
      body: 'One typeface. Two weights.\n',
    }),
  }
}

/** The `*.conflict-<ts>.md` copies actually on disk. */
function copies(root: string): string[] {
  return readdirSync(join(root, 'notes')).filter((name) => name.includes('.conflict-'))
}

/**
 * Type into the open note and let an agent write underneath it, inside the
 * 500 ms save debounce — which is the only way to make the client's etag stale
 * before its own write goes out.
 */
async function collide(page: import('@playwright/test').Page, server: Server) {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Terminal aesthetics/ }).click()
  await expect(page.locator('.cm-content')).toBeFocused()

  await page.keyboard.type('Hairlines are chrome.')
  writeFileSync(
    join(server.vault, NOTE),
    note({
      ref: '003',
      title: 'Terminal aesthetics',
      tags: ['design'],
      body: 'One typeface. Two weights.\nWritten by the agent, at length.\n',
    }),
  )

  await expect.poll(() => copies(server.vault), { timeout: 5000 }).toHaveLength(1)
}

test('an agent writing the open note parks a copy and announces it', async ({ page }) => {
  const server = await serve(vaultWith(vault()))
  try {
    await collide(page, server)

    // The announcement that survives. `notice` is transient prose cleared by the
    // next save; this is derived from the tree, so it is still there afterwards.
    await expect(page.getByRole('button', { name: /1 unresolved/i })).toBeVisible()

    // §04: a copy is "an artefact to merge, not a note". It carries 003's ref and
    // title verbatim, so the index has to say which row is which.
    await expect(
      page.getByRole('button', { name: /\.conflict-.*Unresolved/i }),
    ).toBeVisible()

    // Neither revision is lost — the whole promise of the 409 path.
    const parked = copies(server.vault)[0] ?? ''
    expect(readFileSync(join(server.vault, 'notes', parked), 'utf8')).toContain(
      'Hairlines are chrome.',
    )
    expect(readFileSync(join(server.vault, NOTE), 'utf8')).toContain(
      'Written by the agent',
    )
  } finally {
    server.stop()
  }
})

test('the screen pairs both revisions and merges the chosen lines', async ({ page }) => {
  const server = await serve(vaultWith(vault()))
  try {
    await collide(page, server)
    await page.getByRole('button', { name: /1 unresolved/i }).click()

    // §02b Screen 4: two columns, and it is a screen rather than a modal — the
    // index is still there behind it.
    await expect(page.getByText('Local (your buffer)')).toBeVisible()
    await expect(page.getByText(/Disk \(agent write\)/)).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Index' })).toBeVisible()

    // The gate: nothing may be written until every contested line has a side.
    const write = page.getByRole('button', { name: /Write merge/ })
    await expect(write).toBeDisabled()

    // Take everything from both sides, which is what a person merging two
    // revisions of one paragraph usually means.
    for (const pick of await page.getByRole('button', { name: /^Keep local/ }).all()) {
      await pick.click()
    }
    await expect(page.getByText('[ all lines chosen ]')).toBeVisible()
    await expect(write).toBeEnabled()

    await write.click()

    // The merge is on disk and the copy is retired — in that order, so a failure
    // between them would have left both rather than neither.
    await expect.poll(() => copies(server.vault), { timeout: 5000 }).toHaveLength(0)
    const merged = readFileSync(join(server.vault, NOTE), 'utf8')
    expect(merged).toContain('Hairlines are chrome.')
    expect(merged).toContain('ref: 003')

    // And it lands you back in the note it merged into, per "Write merge → 003".
    await expect(page.locator('.cm-content')).toContainText('Hairlines are chrome.')
    await expect(page.getByRole('button', { name: /unresolved/i })).toBeHidden()
  } finally {
    server.stop()
  }
})

test('choosing the other side keeps that revision and drops nothing else', async ({
  page,
}) => {
  const server = await serve(vaultWith(vault()))
  try {
    await collide(page, server)
    await page.getByRole('button', { name: /1 unresolved/i }).click()

    for (const pick of await page.getByRole('button', { name: /^Keep disk/ }).all()) {
      await pick.click()
    }
    await page.getByRole('button', { name: /Write merge/ }).click()

    await expect.poll(() => copies(server.vault), { timeout: 5000 }).toHaveLength(0)
    const merged = readFileSync(join(server.vault, NOTE), 'utf8')
    // The positive control for the test above: the same flow with the other side
    // chosen has to produce the other text, or neither test is about the choice.
    expect(merged).toContain('Written by the agent')
    expect(merged).not.toContain('Hairlines are chrome.')
    // Lines both sides agreed on are not a choice, and survive either way.
    expect(merged).toContain('One typeface. Two weights.')
  } finally {
    server.stop()
  }
})
