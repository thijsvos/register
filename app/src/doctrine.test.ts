/**
 * Executable design doctrine.
 *
 * §02 and CLAUDE.md state these as prose, and CLAUDE.md rule 7 asserts that "CI
 * greps for strays" — an enforcement that did not exist. Encoding them as tests
 * means a violation fails the phase gate instead of a review, and it costs no
 * new dependency: every source is read through Vite's own glob, not node:fs.
 */
import { describe, expect, it } from 'vitest'
import indexHtml from '../index.html?raw'
// Stylesheets and index.html are imported explicitly with ?raw. They cannot come
// from import.meta.glob: Vite's CSS pipeline outranks the ?raw query there and
// hands back an empty string, which would make every assertion below pass
// vacuously against exactly the files that matter most.
import bootJs from '../public/boot.js?raw'
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

/**
 * TypeScript sources too, not just components.
 *
 * The editor's whole theme lives in `editor/theme.ts` — every colour and every
 * size CodeMirror draws — and for two phases these gates could not see it,
 * because they only scanned `.svelte`. A rule that stops covering the code as
 * the code grows is worse than no rule: it reads as enforcement.
 */
const modules = Object.fromEntries(
  Object.entries(
    import.meta.glob('./**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).filter(([path]) => !path.endsWith('.test.ts') && !path.endsWith('.d.ts')),
)

/** Raw text of every stylesheet and component, keyed by path. */
const sources: Record<string, string> = {
  [TOKENS]: tokensCss,
  [BASE]: baseCss,
  ...components,
  ...modules,
}

const entries = Object.entries(sources)

/**
 * Literal colors: hex, any color-producing function, or a named CSS color.
 *
 * A JS private field spelled in hex — `#face`, `#beef`, `#dad` — trips this. It
 * is left that way on purpose: the false positive fails the build and is fixed
 * by a rename in seconds, while a looser pattern would let a real hardcoded
 * colour through and nobody would notice for a phase.
 */
const LITERAL_COLOR =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(|\b(?:black|white|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|silver|gold|cyan|magenta|lime|navy|teal|olive|maroon|aqua|fuchsia|beige|ivory|coral|salmon|khaki|indigo|violet|crimson|tomato|orchid|plum|tan|azure|linen|snow|wheat)\b(?=\s*[;}),])/gi

/** Any length literal. */
const LENGTH = /\b\d+(?:\.\d+)?px\b/g

/**
 * Reduce a source to the declarations that actually reach the browser. Comments
 * are stripped because they legitimately quote the spec's own numbers and names
 * (§02's "44px", "one ink"), and a scanner that reads prose reports the
 * documentation as a violation. Media-query preludes are stripped because
 * breakpoints cannot be custom properties — @media cannot read them. Container
 * queries are stripped for exactly the same reason: the frame's breakpoints
 * moved to @container so they measure the plate rather than the viewport
 * (§02 "Plate"), and a container prelude can no more read a var() than a media
 * one can.
 */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/@media[^{]*\{/g, '{')
    .replace(/@container[^{]*\{/g, '{')

describe('design tokens (rule 2)', () => {
  it('actually reads every source, so no assertion below passes vacuously', () => {
    expect(entries.length).toBeGreaterThan(5)
    for (const [path, text] of entries) {
      expect(text, `${path} read as empty`).not.toHaveLength(0)
    }
    expect(Object.keys(components).length).toBeGreaterThanOrEqual(6)
    // The editor theme is a .ts file; if it is not here the colour and length
    // gates are blind to every value CodeMirror draws.
    expect(sources['./editor/theme.ts']).toContain('EditorView.theme')
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
    // Every branch of the pattern, not just "it matched something".
    // LITERAL_COLOR is a three-way alternation — hex, colour function, bare
    // keyword — and it is the most complex and most frequently edited regex in
    // the repo. Proving it against tokens.css alone was not enough: breaking
    // the hex branch left the other two matching and the control stayed green,
    // which is how a gate this important would quietly stop guarding hex.
    for (const sample of ['#ff2a00', 'rgba(0,0,0,.5)', 'color: red;']) {
      expect(
        sample.match(LITERAL_COLOR) ?? [],
        `LITERAL_COLOR missed ${sample}`,
      ).not.toHaveLength(0)
    }
  })

  it('declares every length in tokens.css and nowhere else', () => {
    const offenders = entries
      .filter(([path]) => path !== TOKENS)
      .flatMap(([path, text]) =>
        (code(text).match(LENGTH) ?? []).map((hit) => `${path}: ${hit}`),
      )

    expect(offenders).toEqual([])
    expect(code(sources[TOKENS] ?? '').match(LENGTH) ?? []).not.toHaveLength(0)
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
    // tokens.css and base.css are excluded above, so the scanner would report
    // nothing if the regex broke. Prove it still finds the declarations there.
    expect(
      code(sources[BASE] ?? '').match(/font-family:\s*([^;}]+)/g) ?? [],
    ).not.toHaveLength(0)
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
    // A gate that greps for something nobody writes reads identically whether
    // the rule holds or the pattern is broken, so exercise it on a string that
    // must match. Inline rather than from a source: no file may contain one.
    expect(
      /\btransition(?:-[a-z-]+)?\s*:|\bscroll-behavior\s*:\s*smooth/.test(
        'a { transition-duration: 1ms }',
      ),
    ).toBe(true)
  })

  it('declares animation and keyframes only in the status bar', () => {
    // `animation: none` is exempt: it REMOVES motion a dependency shipped,
    // which is the doctrine being enforced rather than broken. Anything that
    // names a duration, a keyframe or a shorthand is not.
    // The quotes matter: a CodeMirror theme is a JS object literal, so the
    // declaration reads `animation: 'none'`, not `animation: none`.
    // The whitespace belongs INSIDE the lookahead. With `\s*` outside it, the
    // engine backtracks it to zero, evaluates the lookahead against the space,
    // trivially fails to see `none` there, and flags every declaration —
    // including the exempt ones.
    const adds =
      /@keyframes\b|\banimation(?:-[a-z-]+)?\s*:(?!\s*['"`]?none['"`]?\s*[;},])/
    const offenders = entries
      .filter(([path]) => path !== LED)
      .filter(([, text]) => adds.test(code(text)))
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

describe('plate scale (§02 "Plate")', () => {
  const tokens = sources[TOKENS] ?? ''

  it('scales the plate by whole multiples only', () => {
    // The pixel grid enforcing itself, not a preference: Departure Mono's em is
    // exactly 11 design pixels, so a fractional multiple puts every design pixel
    // on a fractional device pixel and the micro layer aliases. Measured on a
    // DPR-1 panel: 11px and 22px are crisp; 16px, 16.5px and 19px are not, and
    // rounding a fractional size to a whole pixel does not recover it.
    const declared = [...tokens.matchAll(/--ui-scale:\s*([^;]+);/g)].map((m) =>
      (m[1] ?? '').trim(),
    )
    expect(declared.length).toBeGreaterThan(1)
    for (const value of declared) {
      expect(Number.isInteger(Number(value)), `--ui-scale: ${value}`).toBe(true)
    }
  })

  it('leaves every §02 value at its specified size', () => {
    // The mechanism is `zoom` on the root, so the tokens are never rewritten and
    // 1x is byte-identical. If this ever became `calc(13px * var(--ui-scale))`
    // the frame-geometry assertions above would go with it — and the type scale
    // would be multiplied twice over, because --measure is in ch and the
    // trackings are in em.
    expect(tokens).toMatch(/--text-body:\s*13px;/)
    expect(tokens).not.toMatch(/--text-[a-z]+:\s*calc\(/)
    expect(tokens).not.toMatch(/--frame-[a-z]+:\s*calc\(/)
    expect(sources[BASE]).toMatch(/zoom:\s*var\(--ui-scale\)/)
  })

  it('measures the frame’s breakpoints in plate units, not viewport pixels', () => {
    // A media query answers with the raw viewport, which at 2x is twice the room
    // the frame actually has. All four files move together or the header rules
    // fall out of register with the panes at one scale and not the other.
    for (const path of [
      './ui/App.svelte',
      './ui/Frame/Header.svelte',
      './ui/Frame/Sidebar.svelte',
      './ui/Frame/Inspector.svelte',
    ]) {
      const source = sources[path] ?? ''
      expect(source, `${path} read as empty`).not.toHaveLength(0)
      expect(source, `${path} still asks the viewport`).not.toMatch(
        /@media\s*\(max-width/,
      )
      expect(source, `${path} has no frame breakpoint`).toMatch(
        /@container\s+frame\s*\(max-width/,
      )
    }
    expect(sources['./ui/App.svelte']).toMatch(/container-name:\s*frame/)
  })

  it('divides every viewport unit by the plate scale', () => {
    // vh/vw resolve against the UNZOOMED viewport, so inside a scaled plate they
    // measure --ui-scale times what they say. Measured: an undivided 100dvh at
    // 2x puts the status bar off-screen behind html{overflow:hidden}, with no
    // scrollbar to reach it.
    const viewportUnits = /\b\d+(?:\.\d+)?(?:d?v(?:h|w|min|max))\b/g
    for (const [path, text] of entries) {
      for (const hit of code(text).match(viewportUnits) ?? []) {
        const context = code(text).slice(
          Math.max(0, code(text).indexOf(hit) - 60),
          code(text).indexOf(hit) + hit.length + 40,
        )
        expect(context, `${path}: ${hit} is not divided by the plate scale`).toMatch(
          /var\(--ui-scale\)/,
        )
      }
    }
  })

  it('strips container preludes so the length gate reads declarations only', () => {
    // The same positive control the media-query strip has: without it this
    // reads identically whether the strip works or silently swallows the block
    // it was meant to open.
    expect(code('@container frame (max-width: 900px) { width: 40px; }')).toContain('40px')
    expect(code('@container frame (max-width: 900px) { width: 40px; }')).not.toContain(
      '900px',
    )
  })
})

describe('boot & theme (§02)', () => {
  it('applies the OS scheme before first paint', () => {
    // It used to be an inline <script>, and the server's CSP — `default-src
    // 'self'` with no `script-src` — silently blocked it. v0.3.0 shipped that
    // way: every load logged a violation and booted in the wrong scheme. So the
    // bootstrap is a real file now, and this asserts the property rather than
    // the old spelling.
    expect(bootJs).toMatch(/prefers-color-scheme:\s*dark/)
    expect(bootJs).toMatch(/classList\.add\(['"]dark['"]\)/)

    // Still synchronous and still in <head>, or it does not beat the paint.
    expect(indexHtml).toMatch(/<head>[\s\S]*<script src="\/boot\.js">[\s\S]*<\/head>/)
    expect(indexHtml).not.toMatch(
      /<script src="\/boot\.js"[^>]*\b(defer|async|type="module")/,
    )

    // And no inline script anywhere, because the policy forbids executing one.
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
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

describe('the editor stays lazy (§04: "lazy chunk")', () => {
  // ~103 kB gzipped of CodeMirror arrives when a note is opened, not at boot.
  // One static value-import from the shell side collapses that, and it does so
  // silently: the bundler folds the editor into the entry's static graph, the
  // shell chunk on disk barely moves, and size-limit — which weighs files —
  // reports the budget as met. The rule is greppable, so it is enforced here
  // rather than discovered in a waterfall.
  const shellSide = entries.filter(
    ([path]) =>
      path.startsWith('./ui/') || path.startsWith('./core/') || path.startsWith('./lib/'),
  )

  it('has a shell to check', () => {
    expect(shellSide.length).toBeGreaterThan(5)
  })

  it('never imports the editor statically outside the editor itself', () => {
    // `import type` is erased before the bundler sees it, so it carries no
    // weight and is allowed — that is how Editor.svelte holds an EditorHandle.
    // Multiline but NOT global: a `g` regex driven by `test` carries lastIndex
    // from one file into the next and starts the following scan mid-source.
    const statics =
      /^\s*import\s+(?!type\b)[^;\n]*from\s*['"](?:\.\.\/)+editor(?:\/[^'"]*)?['"]/m
    const offenders = shellSide
      .filter(([, text]) => statics.test(code(text)))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })

  it('still reaches the editor, so the rule above is not vacuous', () => {
    expect(sources['./ui/Editor.svelte']).toMatch(/import\(\s*['"]\.\.\/editor['"]\s*\)/)
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

  it('never fetches a font from the network (§08 P9)', () => {
    // §03's whole legal position rests on this: the OFL faces are vendored and
    // the licensed one comes from the user's own disk. One `@import` from a font
    // CDN would make the app fetch typefaces it has no licence to serve, and
    // leak which vault is open to whoever runs the CDN.
    const remote =
      /(?:@import|src:\s*url\(|fetch\(|new\s+FontFace\([^)]*)['"`]?https?:\/\//i
    const offenders = [...entries, ['../index.html', indexHtml] as const]
      .filter(([, text]) => remote.test(code(text)))
      .map(([path]) => path)

    expect(offenders).toEqual([])
    // And nothing points at the usual suspects, however it is spelled.
    for (const [path, text] of entries) {
      expect(text, path).not.toMatch(/fonts\.(?:googleapis|gstatic|bunny|cdnfonts)/i)
    }
  })

  it('registers a licensed face from the vault, under the family §03 names', () => {
    const byof = sources['./core/settings.svelte.ts'] ?? ''
    expect(byof).toContain('new FontFace(FAMILY')
    expect(byof).toMatch(/const FAMILY = 'TX-02'/)
    // The bytes come from this origin's own server and nowhere else.
    expect(byof).toContain('getFont()')
  })

  it('never references the commercial face as a bundled file', () => {
    const bundled = Object.keys(faces).filter((p) => /berkeley|tx-?02/i.test(p))
    expect(bundled).toEqual([])
    // It may only ever appear as a family NAME in the stack, never as a src url.
    const srcs = baseCss.match(/src:\s*url\([^)]*\)/g) ?? []
    expect(srcs.filter((s) => /berkeley|tx-?02/i.test(s))).toEqual([])
  })
})
