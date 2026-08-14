import { describe, expect, it } from 'vitest'
import { entersEditor, entersIndex, escapeAction } from './keymap'

/**
 * The Escape rule, without a DOM.
 *
 * `installKeymap` itself needs a window to bind to and `HTMLElement` to test
 * against, neither of which exists under Vitest's node environment. The part
 * worth pinning is the decision, not the wiring — so the decision is a pure
 * function and this is the whole of it.
 */
describe('escapeAction', () => {
  /** The ordinary case: a note open, nothing raised over it. */
  const at = (where: Partial<Parameters<typeof escapeAction>[0]>) =>
    escapeAction({
      paletteOpen: false,
      handledAlready: false,
      typing: false,
      raised: false,
      ...where,
    })

  it('closes the palette from anywhere, even mid-word in its own input', () => {
    // The palette is modal: nothing behind it may claim the key first.
    expect(at({ paletteOpen: true, typing: true })).toBe('close-palette')
    expect(at({ paletteOpen: true, handledAlready: true, typing: true })).toBe(
      'close-palette',
    )
    // Including over a raised view, where it would otherwise leave the view and
    // the palette both — one keystroke doing two things.
    expect(at({ paletteOpen: true, raised: true })).toBe('close-palette')
  })

  it('leaves the editor when the caret is in it', () => {
    // Without this the bare keys — N, I, [, ], G-chords — are unreachable
    // whenever a note is open, which is nearly always.
    expect(at({ typing: true })).toBe('leave-editor')
  })

  it('leaves a raised view, which is the only way back to the note', () => {
    // §02b Screen 8: a media surface "replaces the note like TODAY and SETTINGS
    // do ... so leaving puts you back". Nothing implemented leaving, so
    // clicking an image was a one-way trip.
    expect(at({ raised: true })).toBe('leave-view')
  })

  it('stands down when something nearer the event already took it', () => {
    // CodeMirror binds Escape to simplifySelection. With a selection it
    // collapses and calls preventDefault; with a plain caret it returns false
    // and never does. So one Escape clears the selection, a second leaves —
    // rather than a single keystroke doing both.
    expect(at({ handledAlready: true, typing: true })).toBe('nothing')
    // And a field in the inspector that reverted itself keeps its own Escape:
    // the view behind it must not close on the same press.
    expect(at({ handledAlready: true, raised: true })).toBe('nothing')
  })

  it('does nothing when there is nothing to leave', () => {
    expect(at({})).toBe('nothing')
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

describe('entersIndex', () => {
  it('reaches the top of the list with the key that means down', () => {
    expect(entersIndex({ key: 'j', onBody: true })).toBe('first')
    expect(entersIndex({ key: 'ArrowDown', onBody: true })).toBe('first')
  })

  it('reaches the bottom with the key that means up', () => {
    // Each key keeps the direction it has inside the list, so entering is the
    // same gesture as moving rather than a second rule.
    expect(entersIndex({ key: 'k', onBody: true })).toBe('last')
    expect(entersIndex({ key: 'ArrowUp', onBody: true })).toBe('last')
  })

  it('stands down anywhere but <body>', () => {
    // On a row, `traverse` owns these keys — and it declines at the ends, so a
    // global handler firing too would turn the last row's `j` into a jump back
    // to the first. Both directions, or the guard only half exists.
    expect(entersIndex({ key: 'j', onBody: false })).toBe('nothing')
    expect(entersIndex({ key: 'k', onBody: false })).toBe('nothing')
    expect(entersIndex({ key: 'ArrowDown', onBody: false })).toBe('nothing')
  })

  it('leaves every other key alone, including the ones that contain a j or a k', () => {
    // The positive control for the cases above: this runs on every keystroke
    // that reaches the frame, so a pattern that matched loosely would swallow
    // N, I, [, ] and the G-chords.
    //
    // `Backspace` earns its place — it contains a `k`, so a substring match
    // instead of an equality one compiles, passes every other case here, and
    // eats the delete key. `ArrowLeft` and `ArrowRight` are the same trap one
    // token along.
    const untouched = ['n', 'i', '[', ']', 'g', 'Enter', 'h', 'l', 'Escape']
    for (const key of [...untouched, 'Backspace', 'ArrowLeft', 'ArrowRight', 'Tab']) {
      expect(entersIndex({ key, onBody: true }), `${key} was taken`).toBe('nothing')
    }
  })

  it('matches the key whatever case it arrives in', () => {
    expect(entersIndex({ key: 'J', onBody: true })).toBe('first')
    expect(entersIndex({ key: 'arrowup', onBody: true })).toBe('last')
  })
})
