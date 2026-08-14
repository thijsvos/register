import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * §04's "lazy chunk", asserted against the build rather than against the source.
 *
 * `doctrine.test.ts` already bans a static `../editor` import from the shell
 * side, and that ban is not enough — it never was. The regression it exists for
 * happened *in the bundler*: `core/` was hoisted into the editor chunk and the
 * shell was given a static import of it, so all of CodeMirror loaded at boot
 * while every source file still looked correct. §06's JS budget could not see it
 * either, because it weighs `shell-*.js` and the code had moved to `editor-*.js`.
 *
 * So this reads what Vite actually emitted. It lives in the e2e suite for a
 * mechanical reason: CI's `ui` job runs `pnpm test` *before* `pnpm build`, so
 * the same assertion in vitest would pass by finding nothing. The e2e job builds
 * first.
 *
 * No browser is used. Nothing here needs a page, so none is requested.
 */

const dist = join(process.cwd(), 'dist')
const assets = join(dist, 'assets')

/**
 * The specifiers a chunk imports *statically* — the ones the browser must fetch
 * and run before this chunk's first line.
 *
 * `import("./editor-x.js")` is deliberately excluded, because that is the shape
 * the editor is *supposed* to arrive in. The lookahead is what separates them:
 * a dynamic import is `import(`, a `import.meta` is `import.`, and a static one
 * is `import"…"` or `import{…}from"…"`. Minified output has no whitespace to
 * rely on, so the binding list is matched as "anything that is not a quote or a
 * statement end", which an import list never contains.
 */
function staticImports(code: string): string[] {
  const pattern = /\bimport\b\s*(?![(.])(?:[^"';]*?\bfrom\b\s*)?["'](\.\/[^"']+)["']/g
  return [...code.matchAll(pattern)].map((hit) => hit[1] ?? '')
}

function chunk(prefix: string): { name: string; code: string } {
  const name = readdirSync(assets).find(
    (file) => file.startsWith(`${prefix}-`) && file.endsWith('.js'),
  )
  // Anti-vacuity, the shape the `fonts` CI job uses: a missing build must fail
  // this test rather than satisfy it by having nothing to object to.
  expect(name, `no ${prefix}-*.js in ${assets} — run \`pnpm build\` first`).toBeDefined()
  return { name: name ?? '', code: readFileSync(join(assets, name ?? ''), 'utf8') }
}

test('the shell does not drag the editor in at boot', () => {
  const shell = chunk('shell')
  const editor = chunk('editor')

  // The editor exists as its own chunk at all — if the bundler inlined it into
  // the shell there would be nothing to be lazy about, and the check below
  // would pass for the wrong reason.
  expect(editor.name).not.toBe(shell.name)

  const eager = staticImports(shell.code)
  expect(
    eager.find((specifier) => specifier.includes('/editor-')),
    `${shell.name} statically imports the editor chunk: ${eager.join(', ')}`,
  ).toBeUndefined()

  // And the rule is not vacuous — the shell does import something statically,
  // so the extractor is finding real specifiers rather than always returning
  // nothing. `core-*.js` is the shared derivation layer and is meant to be here.
  expect(
    eager.length,
    'no static imports found at all — the extractor is broken',
  ).toBeGreaterThan(0)
})

test('the document asks for the shell and the shared core, and nothing else', () => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8')

  // A `modulepreload` for the editor would load it at boot as surely as a static
  // import would, without ever appearing in the chunk's own import list.
  const preloads = [
    ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
  ].map((hit) => hit[1] ?? '')
  expect(
    preloads.length,
    'no modulepreload at all — the check would be vacuous',
  ).toBeGreaterThan(0)
  expect(
    preloads.find((href) => href.includes('/editor-')),
    `index.html preloads the editor chunk: ${preloads.join(', ')}`,
  ).toBeUndefined()

  // The entry is the shell, not the editor.
  const entry = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? ''
  expect(entry).toContain('/shell-')
})
