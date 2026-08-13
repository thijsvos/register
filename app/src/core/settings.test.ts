import { describe, expect, it } from 'vitest'
import { asConfig, foreign } from './settings.svelte'

/**
 * The config parser, not the class.
 *
 * `Settings` reaches for `FontFace` and `document.fonts`, neither of which
 * exists under Vitest's node environment. What is worth pinning without a DOM is
 * what happens to a config file someone edited by hand — it is a plain JSON file
 * in a folder agents are told to keep out of, so the app has to survive whatever
 * turns up in it.
 *
 * Every assertion below compares the WHOLE returned object rather than the one
 * field under test. That is deliberate and it is why adding `scale` broke nine
 * of them: a parser that silently drops a key is exactly the failure this shape
 * catches, and loosening it to `toMatchObject` would buy a quiet diff today at
 * the price of the gate.
 */
describe('asConfig', () => {
  it('reads a config the settings pane wrote', () => {
    expect(
      asConfig({
        scheme: 'dark',
        bodyFace: 'teletype',
        scale: 2,
        collapsed: ['notes/archive'],
        expanded: [],
      }),
    ).toEqual({
      scheme: 'dark',
      bodyFace: 'teletype',
      scale: 2,
      collapsed: ['notes/archive'],
      expanded: [],
    })
  })

  it('defaults to following the OS, the default face and the canvas', () => {
    // A fresh vault's config.json is `{}` — no choices made, not broken.
    expect(asConfig({})).toEqual({
      scheme: 'system',
      bodyFace: 'default',
      scale: 'auto',
      collapsed: [],
      expanded: [],
    })
  })

  it.each([
    ['null', null],
    ['a string', 'scheme: dark'],
    ['an array', []],
    ['a number', 7],
  ])('survives %s where an object was expected', (_label, value) => {
    expect(asConfig(value)).toEqual({
      scheme: 'system',
      bodyFace: 'default',
      scale: 'auto',
      collapsed: [],
      expanded: [],
    })
  })

  it('ignores a value it does not recognise rather than adopting it', () => {
    // `html.solarized` would never match a rule, so the app would render with no
    // scheme at all and no way to say why.
    expect(asConfig({ scheme: 'solarized', bodyFace: 'comic', scale: 'huge' })).toEqual({
      scheme: 'system',
      bodyFace: 'default',
      scale: 'auto',
      collapsed: [],
      expanded: [],
    })
  })

  it('keeps the half it can read', () => {
    expect(asConfig({ scheme: 'light', bodyFace: 42 })).toEqual({
      scheme: 'light',
      bodyFace: 'default',
      scale: 'auto',
      collapsed: [],
      expanded: [],
    })
  })

  it('ignores keys a later phase has not defined yet', () => {
    expect(asConfig({ scheme: 'dark', flags: { experimental: true } })).toEqual({
      scheme: 'dark',
      bodyFace: 'default',
      scale: 'auto',
      collapsed: [],
      expanded: [],
    })
  })
  describe('scale (§02 "Plate")', () => {
    it.each([['auto', 'auto'] as const, ['1', 1] as const, ['2', 2] as const])(
      'round-trips %s',
      (_label, value) => {
        expect(asConfig({ scale: value }).scale).toBe(value)
      },
    )

    /**
     * The whole defence is identity against a closed set, so the cases that
     * matter are the ones a range check would wave through.
     *
     * `1.5` is the one this exists for: it is a perfectly reasonable-looking
     * scale, and on a DPR-1 panel it puts Departure Mono's 11-design-pixel em on
     * one and a half device pixels and aliases every micro label in the frame.
     * A `typeof value === 'number' && value > 0` guard admits it, and admits
     * `Infinity` and `1e9` too.
     */
    it.each([
      ['a fractional scale the pixel grid forbids', 1.5],
      ['a scale nobody has built', 3],
      ['zero', 0],
      ['a negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a stringly-typed number', '2'],
      ['a boolean', true],
      ['null', null],
    ])('falls back to auto for %s', (_label, value) => {
      expect(asConfig({ scale: value }).scale).toBe('auto')
    })

    // The failure this guards is silent: a config write that forgets a field
    // leaves the app working and the setting quietly unset on the next boot.
    it('does not lose the other settings when the scale is unreadable', () => {
      expect(asConfig({ scheme: 'dark', bodyFace: 'teletype', scale: 1.5 })).toEqual({
        scheme: 'dark',
        bodyFace: 'teletype',
        scale: 'auto',
        collapsed: [],
        expanded: [],
      })
    })
  })

  describe('collapsed folders (§02b Screen 1, Rev N)', () => {
    it('round-trips the folders the reader folded shut', () => {
      expect(
        asConfig({ collapsed: ['notes/archive', 'areas/health'] }).collapsed,
      ).toEqual(['notes/archive', 'areas/health'])
    })

    it.each([
      ['a string', 'notes/archive'],
      ['an object', { 'notes/archive': true }],
      ['null', null],
      ['a number', 3],
    ])('falls back to nothing folded for %s', (_label, value) => {
      expect(asConfig({ collapsed: value }).collapsed).toEqual([])
    })

    it('drops the entries it cannot read rather than the whole list', () => {
      // One hand-edited line should cost one folder's fold state, not the
      // reader's whole tree.
      expect(
        asConfig({ collapsed: ['notes/archive', 7, '', null, 'areas'] }).collapsed,
      ).toEqual(['notes/archive', 'areas'])
    })

    it('does not lose the other settings when the list is unreadable', () => {
      expect(asConfig({ scheme: 'dark', scale: 2, collapsed: 'oops' })).toEqual({
        scheme: 'dark',
        bodyFace: 'default',
        scale: 2,
        collapsed: [],
        expanded: [],
      })
    })
  })
})

/**
 * The other half of the same read.
 *
 * `asConfig` answers what the settings screen may *use*; this answers what it
 * must put *back*. PUT replaces the whole file (§05), so a key the screen cannot
 * show and does not carry is erased by the next thing it writes — which is how
 * folding a folder in the INDEX turned off a vault's checkpoints.
 */
describe('foreign', () => {
  it('keeps a flag only the server reads', () => {
    expect(foreign({ scheme: 'dark', checkpoints: true })).toEqual({ checkpoints: true })
  })

  it('keeps nothing the settings screen owns', () => {
    expect(
      foreign({
        scheme: 'dark',
        bodyFace: 'teletype',
        scale: 2,
        collapsed: ['notes/archive'],
        expanded: ['daily'],
      }),
    ).toEqual({})
  })

  it('preserves a value it cannot interpret, whatever shape it is', () => {
    // Untouched all the way down: an unknown key's value is unknown too, so
    // re-serialising it verbatim is the most that can honestly be done with it.
    const held = { nested: { deep: [1, 'two', null] }, count: 0, off: false }
    expect(foreign({ scheme: 'light', ...held })).toEqual(held)
  })

  it.each([
    ['null', null],
    ['a string', 'checkpoints: true'],
    ['a number', 7],
    ['an array', ['checkpoints']],
  ])('has nothing to keep from %s', (_label, value) => {
    // The array case is not idle: `typeof [] === 'object'`, so without a guard
    // this returns `{0: 'checkpoints'}` and writes numbered keys into the file.
    expect(foreign(value)).toEqual({})
  })
})
