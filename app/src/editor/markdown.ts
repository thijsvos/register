import { defineLanguageFacet, Language, languageDataProp } from '@codemirror/language'
import { GFM, parser } from '@lezer/markdown'

/**
 * The markdown language, assembled from the Lezer grammar directly.
 *
 * §04 names `@codemirror/lang-markdown`, and it cannot be used: line 6 of its
 * dist is a *static* `import { html } from '@codemirror/lang-html'`, which
 * transitively pulls lang-javascript, lang-css, @codemirror/autocomplete,
 * @codemirror/lint and three more Lezer grammars. Measured on the real build,
 * that is 175 kB gzipped against §06's 150 kB editor budget; assembling the
 * language here instead measures 98 kB. No configuration removes it — the
 * import is static and those modules have side-effectful init, so tree-shaking
 * cannot drop them. Hard rule 3: shrink the change, not the budget.
 * See docs/ADRs/003-markdown-language.md.
 *
 * GFM is included because task lists are part of it: `- [ ]` only parses into
 * Task / TaskMarker nodes with the GFM extension, and those nodes are what the
 * checkbox decoration attaches to.
 */
const facet = defineLanguageFacet({
  commentTokens: { block: { open: '<!--', close: '-->' } },
})

export const markdownLanguage = new Language(
  facet,
  parser.configure([GFM, { props: [languageDataProp.add({ Document: facet })] }]),
  [],
  'markdown',
)
