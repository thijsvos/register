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
