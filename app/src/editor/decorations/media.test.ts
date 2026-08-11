import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { markdownLanguage } from '../markdown'
import { ImageEmbed, imageEmbeds } from './media'
import { type WikiLinkHost, wikiLinkHost } from './wikilinks'

/**
 * The field, driven headlessly.
 *
 * `toDOM` is untestable here — there is no jsdom (ADR-005) — but everything that
 * decides *whether* an image is drawn and *where* is state, not DOM: the tree
 * walk, the regex, and the host's answer. Those are what this covers.
 */
const host: WikiLinkHost = {
  exists: () => false,
  open: () => {},
  // Stands in for `resolveSrc` + `fileUrl`, which have their own tests: what
  // matters here is that a `null` suppresses the widget and a string draws one.
  fileUrl: (src) => (src.startsWith('http') ? null : `/api/file/notes/${src}`),
  openFile: () => {},
  fileMissing: () => false,
}

function embedsIn(doc: string): { at: number; url: string; alt: string }[] {
  const state = EditorState.create({
    doc,
    extensions: [markdownLanguage, imageEmbeds, wikiLinkHost.of(host)],
  })
  const found: { at: number; url: string; alt: string }[] = []
  state.field(imageEmbeds).between(0, state.doc.length, (_from, _to, value) => {
    const widget = value.spec.widget
    if (widget instanceof ImageEmbed) {
      found.push({ at: widget.at, url: widget.url, alt: widget.alt })
    }
  })
  return found
}

describe('imageEmbeds', () => {
  it('draws one image per reference, with its alt text', () => {
    const found = embedsIn('Before\n\n![The frame](diagram.png)\n\nAfter\n')
    expect(found).toHaveLength(1)
    expect(found[0]?.url).toBe('/api/file/notes/diagram.png')
    expect(found[0]?.alt).toBe('The frame')
  })

  it('draws nothing for a note with no references', () => {
    expect(embedsIn('Just prose, and a [link](note.md).\n')).toHaveLength(0)
  })

  it('leaves a reference the host will not serve alone', () => {
    // A remote URL: `img-src 'self'` would refuse it, and a broken frame is
    // worse than the plain text the author wrote.
    expect(embedsIn('![Remote](https://example.com/x.png)\n')).toHaveLength(0)
  })

  it('does not treat a reference inside a code fence as one', () => {
    // The whole reason this reads the syntax tree rather than scanning text the
    // way the wikilink decoration has to: a fenced example is documentation,
    // not a reference, and rendering it would be rendering someone's prose.
    const found = embedsIn('```md\n![Not real](diagram.png)\n```\n')
    expect(found).toHaveLength(0)
  })

  it('anchors the widget after the line, not inside it', () => {
    // Block widgets sit between lines; anchoring mid-line would split the
    // paragraph the reference is written in.
    const doc = 'Text ![One](a.png) more text\nnext line\n'
    const state = EditorState.create({
      doc,
      extensions: [markdownLanguage, imageEmbeds, wikiLinkHost.of(host)],
    })
    const line = state.doc.lineAt(0)
    let at = -1
    state.field(imageEmbeds).between(0, doc.length, (from) => {
      at = from
    })
    expect(at).toBe(line.to)
  })

  it('handles several references in one note', () => {
    const found = embedsIn('![A](a.png)\n\n![B](b.png)\n\n![C](c.png)\n')
    expect(found.map((f) => f.alt)).toEqual(['A', 'B', 'C'])
  })

  it('reads a reference with no alt text', () => {
    const found = embedsIn('![](a.png)\n')
    expect(found).toHaveLength(1)
    expect(found[0]?.alt).toBe('')
  })
})

describe('ImageEmbed', () => {
  it('is equal only when everything the DOM node closed over is equal', () => {
    // Position is in `eq` for `TaskToggle`'s reason: the node closes over it, so
    // reusing one whose line has moved leaves the image on the wrong reference.
    const one = new ImageEmbed('a.png', '/api/file/a.png', 'A', 10)
    expect(one.eq(new ImageEmbed('a.png', '/api/file/a.png', 'A', 10))).toBe(true)
    expect(one.eq(new ImageEmbed('a.png', '/api/file/a.png', 'A', 11))).toBe(false)
    expect(one.eq(new ImageEmbed('a.png', '/api/file/b.png', 'A', 10))).toBe(false)
    expect(one.eq(new ImageEmbed('a.png', '/api/file/a.png', 'B', 10))).toBe(false)
    expect(one.eq(new ImageEmbed('b.png', '/api/file/a.png', 'A', 10))).toBe(false)
  })

  it('reserves a height, so a long note does not jump as images decode', () => {
    expect(
      new ImageEmbed('a.png', '/api/file/a.png', '', 0).estimatedHeight,
    ).toBeGreaterThan(0)
  })
})
