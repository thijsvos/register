import { describe, expect, it } from 'vitest'
import { asConfig } from './settings.svelte'

/**
 * The config parser, not the class.
 *
 * `Settings` reaches for `FontFace` and `document.fonts`, neither of which
 * exists under Vitest's node environment. What is worth pinning without a DOM is
 * what happens to a config file someone edited by hand — it is a plain JSON file
 * in a folder agents are told to keep out of, so the app has to survive whatever
 * turns up in it.
 */
describe('asConfig', () => {
  it('reads a config the settings pane wrote', () => {
    expect(asConfig({ scheme: 'dark', bodyFace: 'teletype' })).toEqual({
      scheme: 'dark',
      bodyFace: 'teletype',
    })
  })

  it('defaults to following the OS and the default face', () => {
    // A fresh vault's config.json is `{}` — no choices made, not broken.
    expect(asConfig({})).toEqual({ scheme: 'system', bodyFace: 'default' })
  })

  it.each([
    ['null', null],
    ['a string', 'scheme: dark'],
    ['an array', []],
    ['a number', 7],
  ])('survives %s where an object was expected', (_label, value) => {
    expect(asConfig(value)).toEqual({ scheme: 'system', bodyFace: 'default' })
  })

  it('ignores a value it does not recognise rather than adopting it', () => {
    // `html.solarized` would never match a rule, so the app would render with no
    // scheme at all and no way to say why.
    expect(asConfig({ scheme: 'solarized', bodyFace: 'comic' })).toEqual({
      scheme: 'system',
      bodyFace: 'default',
    })
  })

  it('keeps the half it can read', () => {
    expect(asConfig({ scheme: 'light', bodyFace: 42 })).toEqual({
      scheme: 'light',
      bodyFace: 'default',
    })
  })

  it('ignores keys a later phase has not defined yet', () => {
    expect(asConfig({ scheme: 'dark', flags: { experimental: true } })).toEqual({
      scheme: 'dark',
      bodyFace: 'default',
    })
  })
})
