/**
 * Executable design doctrine.
 *
 * §02 and CLAUDE.md state these as prose, and CLAUDE.md rule 7 asserts that "CI
 * greps for strays" — an enforcement that did not exist. Encoding them as tests
 * means a violation fails the phase gate instead of a review, and it costs no
 * new dependency: every source is read through Vite's own glob, not node:fs.
 */
import { describe, expect, it } from 'vitest'
// Stylesheets and index.html are imported explicitly with ?raw. They cannot come
// from import.meta.glob: Vite's CSS pipeline outranks the ?raw query there and
// hands back an empty string, which would make every assertion below pass
// vacuously against exactly the files that matter most.
import indexHtml from '../index.html?raw'
import baseCss from './styles/base.css?raw'
import tokensCss from './styles/tokens.css?raw'
import viewState from './ui/view.svelte.ts?raw'

const TOKENS = './styles/tokens.css'
const BASE = './styles/base.css'

const components = import.meta.glob('./**/*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Raw text of every stylesheet and component, keyed by path. */
const sources: Record<string, string> = {
  [TOKENS]: tokensCss,
  [BASE]: baseCss,
  ...components,
}

const entries = Object.entries(sources)

/** Literal colors: hex, any color-producing function, or a named CSS color. */
const LITERAL_COLOR =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(|\b(?:black|white|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|silver|gold|cyan|magenta|lime|navy|teal|olive|maroon|aqua|fuchsia|beige|ivory|coral|salmon|khaki|indigo|violet|crimson|tomato|orchid|plum|tan|azure|linen|snow|wheat)\b(?=\s*[;}),])/gi

/** Any length literal. */
const LENGTH = /\b\d+(?:\.\d+)?px\b/g

/**
 * Reduce a source to the declarations that actually reach the browser. Comments
 * are stripped because they legitimately quote the spec's own numbers and names
 * (§02's "44px", "one ink"), and a scanner that reads prose reports the
 * documentation as a violation. Media-query preludes are stripped because
 * breakpoints cannot be custom properties — @media cannot read them.
 */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/@media[^{]*\{/g, '{')

describe('design tokens (rule 2)', () => {
  it('actually reads every source, so no assertion below passes vacuously', () => {
    expect(entries.length).toBeGreaterThan(5)
    for (const [path, text] of entries) {
      expect(text, `${path} read as empty`).not.toHaveLength(0)
    }
    expect(Object.keys(components).length).toBeGreaterThanOrEqual(6)
    expect(sources[TOKENS]).toContain('--signal')
    expect(sources[BASE]).toContain('@font-face')
    expect(indexHtml).toContain('<html')
  })

  it('declares every literal color in tokens.css and nowhere else', () => {
    const offenders = entries
      .filter(([path]) => path !== TOKENS)
      .flatMap(([path, text]) =>
        (code(text).match(LITERAL_COLOR) ?? []).map((hit) => `${path}: ${hit}`),
      )

    expect(offenders).toEqual([])
  })

  it('declares every length in tokens.css and nowhere else', () => {
    const offenders = entries
      .filter(([path]) => path !== TOKENS)
      .flatMap(([path, text]) =>
        (code(text).match(LENGTH) ?? []).map((hit) => `${path}: ${hit}`),
      )

    expect(offenders).toEqual([])
  })

  it('routes every font-family through a token', () => {
    const offenders = entries
      .filter(([path]) => path !== TOKENS && path !== BASE)
      .flatMap(([path, text]) =>
        [...code(text).matchAll(/font-family:\s*([^;}]+)/g)]
          .filter((m) => !(m[1] ?? '').includes('var(--font-'))
          .map((m) => `${path}: ${m[0]}`),
      )

    expect(offenders).toEqual([])
  })
})

describe('motion doctrine (§02: zero animations except the status LED)', () => {
  const LED = './ui/Frame/StatusBar.svelte'

  it('declares no transitions anywhere, longhand included', () => {
    const offenders = entries
      .filter(([, text]) =>
        /\btransition(?:-[a-z-]+)?\s*:|\bscroll-behavior\s*:\s*smooth/.test(code(text)),
      )
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })

  it('declares animation and keyframes only in the status bar', () => {
    const offenders = entries
      .filter(([path]) => path !== LED)
      .filter(([, text]) => /\banimation(?:-[a-z-]+)?\s*:|@keyframes\b/.test(code(text)))
      .map(([path]) => path)

    expect(offenders).toEqual([])
    expect(sources[LED]).toMatch(/@keyframes\b/)
  })

  it('stills the LED under prefers-reduced-motion', () => {
    expect(sources[LED]).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
  })
})

describe('frame geometry (§02 component doctrine)', () => {
  const tokens = sources[TOKENS] ?? ''

  // "header rail (44px) / sidebar (250px) / editor / inspector (268px) /
  //  status bar (30px), separated by 1px hairlines."
  it.each([
    ['--frame-header', '44px'],
    ['--frame-side', '250px'],
    ['--frame-insp', '268px'],
    ['--frame-foot', '30px'],
    ['--hairline', '1px'],
  ])('pins %s to %s', (token, value) => {
    expect(tokens).toMatch(new RegExp(`${token}:\\s*${value};`))
  })

  it('lays the frame out from those tokens, not from literals', () => {
    const app = sources['./ui/App.svelte'] ?? ''
    expect(app).toMatch(
      /grid-template-rows:\s*var\(--frame-header\).*var\(--frame-foot\)/,
    )
    expect(app).toMatch(
      /grid-template-columns:\s*var\(--frame-side\).*var\(--frame-insp\)/,
    )
  })

  it('keeps the micro layer on Departure Mono’s 11px pixel grid', () => {
    expect(tokens).toMatch(/--text-micro:\s*11px;/)
    // Half-leading must be a whole pixel or the bitmap face blurs.
    const lh = Number((tokens.match(/--lh-micro:\s*(\d+)px;/) ?? [])[1])
    expect(Number.isInteger((lh - 11) / 2)).toBe(true)
  })

  it('puts the brand rule on the same vertical line as the sidebar rule', () => {
    expect(sources['./ui/Frame/Header.svelte']).toMatch(
      /min-width:\s*var\(--frame-side\)/,
    )
  })
})

describe('boot & theme (§02)', () => {
  it('applies the OS scheme before first paint', () => {
    expect(indexHtml).toMatch(/prefers-color-scheme:\s*dark/)
    expect(indexHtml).toMatch(/classList\.add\(['"]dark['"]\)/)
    // The boot script must be inline in <head>, not a deferred module.
    expect(indexHtml).toMatch(/<head>[\s\S]*prefers-color-scheme[\s\S]*<\/head>/)
  })

  it('declares color-scheme per theme', () => {
    expect(indexHtml).toMatch(/name="color-scheme"/)
    expect(baseCss).toMatch(/html\s*\{[^}]*color-scheme:\s*light/)
    expect(baseCss).toMatch(/html\.dark\s*\{[^}]*color-scheme:\s*dark/)
  })

  it('keeps responding to the OS after boot', () => {
    // Lives in the chrome state module, not the component: the palette's
    // INVERT command needs the same toggle the header button uses.
    expect(viewState).toMatch(/addEventListener\(\s*['"]change['"]/)
    expect(viewState).toMatch(/removeEventListener\(\s*['"]change['"]/)
  })

  it('swaps rather than blocks on every face, and preloads the shell', () => {
    const faces = baseCss.match(/@font-face\s*\{[^}]*\}/g) ?? []
    expect(faces.length).toBeGreaterThanOrEqual(3)
    for (const face of faces) expect(face).toMatch(/font-display:\s*swap/)
    expect((indexHtml.match(/rel="preload"/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('font licensing (rule 7, §03)', () => {
  const faces = import.meta.glob('../public/fonts/**/*.woff2')
  const licenses = import.meta.glob('../public/fonts/**/OFL.txt')
  const strayFormats = import.meta.glob('../public/fonts/**/*.{ttf,otf,woff,eot}')

  const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

  it('vendors at least the three OFL faces', () => {
    expect(Object.keys(faces).length).toBeGreaterThanOrEqual(3)
  })

  it('puts an OFL.txt beside every vendored face', () => {
    const licensed = new Set(Object.keys(licenses).map(dirOf))
    const unlicensed = [...new Set(Object.keys(faces).map(dirOf))].filter(
      (d) => !licensed.has(d),
    )

    expect(unlicensed).toEqual([])
  })

  it('vendors woff2 only', () => {
    expect(Object.keys(strayFormats)).toEqual([])
  })

  it('never references the commercial face as a bundled file', () => {
    const bundled = Object.keys(faces).filter((p) => /berkeley|tx-?02/i.test(p))
    expect(bundled).toEqual([])
    // It may only ever appear as a family NAME in the stack, never as a src url.
    const srcs = baseCss.match(/src:\s*url\([^)]*\)/g) ?? []
    expect(srcs.filter((s) => /berkeley|tx-?02/i.test(s))).toEqual([])
  })
})
