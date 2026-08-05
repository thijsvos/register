import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A real `register serve` over a real vault, for the duration of one spec file.
 *
 * The binary is the release build — the thing §06's budgets are about — and it
 * is started on port 0 so specs never collide. Its banner names the address it
 * actually bound, which is the only way to learn an ephemeral port.
 */
export interface Server {
  url: string
  vault: string
  /** For §06's idle-RSS budget, which is about this process and not the page. */
  pid: number
  stop: () => void
}

const BINARY = join(process.cwd(), '..', 'target', 'release', 'register')

export function vaultWith(notes: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'register-e2e-'))
  for (const dir of ['notes', 'daily', 'templates', '.register']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  for (const [rel, body] of Object.entries(notes)) {
    writeFileSync(join(root, rel), body)
  }
  return root
}

/** A conforming §04 note. */
export function note(options: {
  ref: string
  title: string
  body?: string
  tags?: string[]
}): string {
  return [
    '---',
    `id: 01J2ZK7Q8W3E5R9T${options.ref.padStart(9, '0')}`,
    `ref: ${options.ref}`,
    `title: ${options.title}`,
    'created: 2026-08-05',
    'modified: 2026-08-05T09:16:40Z',
    `tags: [${(options.tags ?? []).join(', ')}]`,
    '---',
    options.body ?? '',
  ].join('\n')
}

export async function serve(vault: string): Promise<Server> {
  const child = spawn(BINARY, ['serve', vault, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  const url = await new Promise<string>((resolve, reject) => {
    let banner = ''
    const timer = setTimeout(
      () => reject(new Error(`no banner from the server: ${banner}`)),
      10_000,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      banner += chunk.toString()
      const found = /http:\/\/[^\s]+/.exec(banner)
      if (found !== null) {
        clearTimeout(timer)
        resolve(found[0].trim())
      }
    })
    child.on('error', reject)
  })

  return {
    url,
    vault,
    pid: child.pid ?? 0,
    stop: () => {
      child.kill()
    },
  }
}

/** Resident memory of the server process, in bytes (§06: idle RSS ≤ 50 MB). */
export function rss(pid: number): number {
  const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)])
    .toString()
    .trim()
  // `ps` reports kilobytes on both macOS and Linux.
  return Number(out) * 1024
}

/**
 * Milliseconds from `act()` to `text` appearing in the editor, measured inside
 * the page.
 *
 * Playwright's `expect` polls on a schedule that starts at 100 ms, so a budget
 * of 100 ms measured that way reports the polling interval rather than the app.
 * A MutationObserver fires when the DOM actually changes, and the observer is
 * armed before the action so nothing is missed.
 */
export async function msUntilVisible(
  page: import('@playwright/test').Page,
  text: string,
  act: () => void | Promise<void>,
): Promise<number> {
  const started = await page.evaluate(() => performance.now())

  const seen = page.evaluate(
    (needle) =>
      new Promise<number>((resolve) => {
        const target = document.querySelector('.cm-content')
        if (target === null) return resolve(Number.NaN)
        const hit = () => (target.textContent ?? '').includes(needle)
        if (hit()) return resolve(performance.now())

        const observer = new MutationObserver(() => {
          if (!hit()) return
          observer.disconnect()
          resolve(performance.now())
        })
        observer.observe(target, {
          childList: true,
          subtree: true,
          characterData: true,
        })
      }),
    text,
  )

  await act()
  return (await seen) - started
}
