import { describe, expect, it } from 'vitest'
import { entersEditor, escapeAction } from './keymap'

/**
 * The Escape rule, without a DOM.
 *
 * `installKeymap` itself needs a window to bind to and `HTMLElement` to test
 * against, neither of which exists under Vitest's node environment. The part
 * worth pinning is the decision, not the wiring — so the decision is a pure
 * function and this is the whole of it.
 */
describe('escapeAction', () => {
  it('closes the palette from anywhere, even mid-word in its own input', () => {
    // The palette is modal: nothing behind it may claim the key first.
    expect(escapeAction({ paletteOpen: true, handledAlready: false, typing: true })).toBe(
      'close-palette',
    )
    expect(escapeAction({ paletteOpen: true, handledAlready: true, typing: true })).toBe(
      'close-palette',
    )
  })

  it('leaves the editor when the caret is in it', () => {
    // Without this the bare keys — N, I, [, ], G-chords — are unreachable
    // whenever a note is open, which is nearly always.
    expect(
      escapeAction({ paletteOpen: false, handledAlready: false, typing: true }),
    ).toBe('leave-editor')
  })

  it('stands down when something nearer the event already took it', () => {
    // CodeMirror binds Escape to simplifySelection. With a selection it
    // collapses and calls preventDefault; with a plain caret it returns false
    // and never does. So one Escape clears the selection, a second leaves —
    // rather than a single keystroke doing both.
    expect(escapeAction({ paletteOpen: false, handledAlready: true, typing: true })).toBe(
      'nothing',
    )
  })

  it('does nothing when there is nothing to leave', () => {
    expect(
      escapeAction({ paletteOpen: false, handledAlready: false, typing: false }),
    ).toBe('nothing')
  })
})

describe('entersEditor', () => {
  it('takes Enter only from <body>, where Escape leaves you', () => {
    expect(entersEditor({ onBody: true, paletteOpen: false })).toBe(true)
  })

  it('never takes Enter from a focused row', () => {
    // Enter on an index row has to open that row. A global binding would eat
    // the keyboard navigation this return trip exists to serve.
    expect(entersEditor({ onBody: false, paletteOpen: false })).toBe(false)
  })

  it('never takes Enter from the palette, where it runs the selection', () => {
    expect(entersEditor({ onBody: true, paletteOpen: true })).toBe(false)
  })
})
