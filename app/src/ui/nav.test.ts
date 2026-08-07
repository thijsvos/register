import { beforeEach, describe, expect, it, vi } from 'vitest'
import { vault } from '../core/store.svelte'
import { go } from './nav'
import { chrome } from './view.svelte'

/**
 * The one invariant `nav.ts` exists to hold: every route that lands the user in
 * a note puts the note back on screen first.
 *
 * The module's own docstring names the failure — "a note opening behind an
 * aggregate that is still showing yesterday's tasks" — and seven call sites
 * depend on it: the sidebar, the palette, the keymap, the inspector, TODAY, the
 * editor and the palette's template list. Nothing tested it. A new route added
 * without `chrome.showNotes()` would look correct in review and be wrong only
 * when someone opened a note from TODAY.
 *
 * The store calls are stubbed rather than mocked, following `store.test.ts`:
 * what is under test is the chrome flag, not the fetch behind it.
 */

const ROUTES_TO_A_NOTE: [string, () => void][] = [
  ['note', () => go.note('notes/003-a.md')],
  ['create', () => go.create('Untitled note')],
  ['create from a template', () => go.create('Untitled', 'templates/daily.md')],
  ['daily', () => go.daily()],
  ['follow', () => go.follow('003')],
]

beforeEach(() => {
  // Every route fires a store call that would reach for `fetch`. The routing
  // decision happens before that, so the calls are neutered rather than served.
  for (const method of ['open', 'create', 'openDaily', 'follow'] as const) {
    vi.spyOn(vault, method).mockResolvedValue(undefined as never)
  }
})

describe('go', () => {
  it.each(ROUTES_TO_A_NOTE)('%s leaves the note on screen', (_case, route) => {
    chrome.showToday()
    expect(chrome.today, 'precondition: TODAY is up').toBe(true)

    route()

    expect(chrome.today, 'a note opened behind TODAY').toBe(false)
    expect(chrome.settings).toBe(false)
  })

  it.each(ROUTES_TO_A_NOTE)('%s also comes back from settings', (_case, route) => {
    chrome.showSettings()
    expect(chrome.settings, 'precondition: settings is up').toBe(true)

    route()

    expect(chrome.settings, 'a note opened behind settings').toBe(false)
    expect(chrome.today).toBe(false)
  })

  it('still reaches the store, so the routes above are not merely flag-setters', () => {
    // The positive control. Every assertion above is about what `go` turns
    // *off*; without this they would all pass against a `go` that navigated
    // nowhere at all.
    go.note('notes/003-a.md')
    expect(vault.open).toHaveBeenCalledWith('notes/003-a.md')

    go.create('A title', 'templates/daily.md')
    expect(vault.create).toHaveBeenCalledWith('A title', 'templates/daily.md')

    go.daily()
    expect(vault.openDaily).toHaveBeenCalled()

    go.follow('003')
    expect(vault.follow).toHaveBeenCalledWith('003')
  })

  it('today and settings are the two routes that do not open a note', () => {
    go.today()
    expect(chrome.today).toBe(true)
    expect(chrome.settings).toBe(false)

    go.settings()
    expect(chrome.settings).toBe(true)
    // The two are mutually exclusive: §02b has one main region, and both
    // claiming it would render whichever the template happens to test first.
    expect(chrome.today).toBe(false)
  })
})
