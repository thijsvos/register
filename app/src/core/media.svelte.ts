/**
 * Which referenced files turned out not to be there.
 *
 * The client cannot know this any other way. Media is deliberately absent from
 * `GET /api/tree` — §04 lists notes, and widening that would change what the
 * tree, the watcher and the note API all share one definition of — so a
 * reference's target is unknown until a browser tries to fetch it. The `<img>`
 * that renders an embed is the only thing that finds out, and this is where it
 * says so.
 *
 * In memory, never in the vault: hard rule 4 forbids state the vault cannot
 * express, and "this URL 404'd once in this tab" is not knowledge about anyone's
 * notes. It is not persisted and it is not meant to be.
 */
import { fileLeftOut } from './api'

class Misses {
  #paths = new Set<string>()

  /**
   * Bumped on every new miss, and read by anything that needs to re-run.
   *
   * A counter rather than a reactive Set: `$state` does not track mutations
   * inside a Set, so a component reading `has(...)` would never re-render. One
   * number that changes is enough, because every reader re-asks anyway.
   */
  version = $state(0)

  /**
   * Has this vault path already failed to load in this session — or, in an
   * extract, was it never carried at all (§12)? The second is known before
   * anything is tried, and it is the same fact drawn the same way.
   */
  missing(path: string): boolean {
    return this.#paths.has(path) || fileLeftOut(path)
  }

  /**
   * Record a target the browser could not load.
   *
   * Never cleared. The watcher is `.md`-only, so nothing would tell us the file
   * had appeared — and re-trying on every tree change would mean re-requesting a
   * 404 on every keystroke that saves. Adding the file and reloading is the
   * recovery, which is the same answer the roadmap already gives for a *changed*
   * image not repainting.
   */
  mark(path: string): void {
    if (this.#paths.has(path)) return
    this.#paths.add(path)
    this.version += 1
  }
}

export const misses = new Misses()
