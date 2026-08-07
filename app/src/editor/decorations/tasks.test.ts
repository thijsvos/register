import { describe, expect, it } from 'vitest'
import { TaskToggle } from './tasks'

/**
 * `TaskToggle.eq` decides whether CodeMirror may reuse an existing checkbox DOM
 * node instead of rebuilding it.
 *
 * The widget's own docstring names the bug this guards: the node closes over
 * `at`, the document position of the `[`, so reusing a node whose line has since
 * moved would toggle the wrong character — silently ticking a different task.
 *
 * `journey.spec.ts` clicks a real checkbox and proves the write reaches the
 * file, but it only ever has one task on screen and never moves it, so the
 * position half of identity is invisible there. `eq` is pure and needs no DOM,
 * which is the whole reason it can be tested here at all — `toDOM` cannot,
 * there being no jsdom in this project (ADR-005).
 */
describe('TaskToggle.eq', () => {
  it('is the same widget only when state and position both match', () => {
    const widget = new TaskToggle(false, 10)

    expect(widget.eq(new TaskToggle(false, 10)), 'identical widgets differ').toBe(true)

    // Ticking it is a different widget: the glyph and aria-checked change.
    expect(
      widget.eq(new TaskToggle(true, 10)),
      'a ticked box reused an unticked node',
    ).toBe(false)

    // And so is the same state one line further down. This is the case that
    // matters: without it, editing a line above a task lets CodeMirror keep a
    // node pointing at the old offset, and the next click edits the wrong byte.
    expect(widget.eq(new TaskToggle(false, 11)), 'a moved box reused a stale node').toBe(
      false,
    )
    expect(widget.eq(new TaskToggle(true, 11))).toBe(false)
  })

  it('keeps the position it was given, because toDOM writes at exactly at + 1', () => {
    // The dispatch in `toDOM` is `{ from: at + 1, to: at + 2 }` — a
    // one-character replacement, so the vault's diff stays minimal. That
    // arithmetic is only correct while `at` is the position of the `[`.
    const widget = new TaskToggle(true, 42)
    expect(widget.at).toBe(42)
    expect(widget.checked).toBe(true)
  })
})
