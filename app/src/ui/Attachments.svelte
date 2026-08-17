<script lang="ts">
import { getFiles } from '../core/api'
import { basename, resolveSrc } from '../core/paths'
import { vault } from '../core/store.svelte'
import { go } from './nav'
import { chrome } from './view.svelte'

/**
 * §02b Screen 10 — every file the INDEX never draws.
 *
 * The index is a register of *notes*, so an image whose note was deleted is
 * invisible in the app: it exists, it takes up space, and Finder is the only way
 * to it. This is the one surface that admits a vault holds more than prose.
 *
 * **What references what is worked out here, not asked for.** The server lists
 * paths; the client already holds every note body in the corpus and can see
 * every `![](src)` in them. Asking the server would have meant it parsing
 * markdown to answer a question about files, which is the client's job by every
 * other division in this codebase.
 */
let files = $state<string[]>([])
let loaded = $state(false)

$effect(() => {
  void (async () => {
    try {
      files = await getFiles()
    } catch (error) {
      vault.notice = error instanceof Error ? error.message : String(error)
    }
    loaded = true
  })()
})

/** Every `![alt](src)` and `[text](src)` a note points at, as a vault path. */
const REFERENCE = /!?\[[^\]]*\]\(([^)\s]+)\)/g

/**
 * file path → the notes referencing it.
 *
 * Rebuilt from the corpus whenever it moves, which is the same derivation the
 * backlinks pane already does for wikilinks — nothing is stored.
 */
let referencedBy = $derived.by(() => {
  const map = new Map<string, string[]>()
  for (const [notePath, held] of Object.entries(vault.corpus)) {
    for (const match of held.body.matchAll(REFERENCE)) {
      const src = match[1]
      if (src === undefined || /^[a-z]+:/i.test(src)) continue
      const resolved = resolveSrc(notePath, decodeURI(src))
      if (resolved === null) continue
      const seen = map.get(resolved) ?? []
      if (!seen.includes(notePath)) seen.push(notePath)
      map.set(resolved, seen)
    }
  }
  return map
})

let orphans = $derived(
  files.filter((path) => (referencedBy.get(path) ?? []).length === 0),
)

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function titleOf(path: string): string {
  return vault.tree.find((entry) => entry.path === path)?.title ?? basename(path)
}
</script>

<div class="attachments">
  <div class="head">
    <div class="stamp">
      <span>Attachments · derived from the vault</span>
      <button class="back" onclick={() => chrome.showNotes()}>[Esc] back</button>
    </div>
    <div class="title">
      <h2>Attachments</h2>
      <span class="meta">
        {files.length === 0 ? '' : count(files.length, 'file')}{orphans.length === 0
          ? ''
          : ` · ${orphans.length} referenced by nothing`}
      </span>
    </div>
  </div>

  {#if !loaded}
    <p class="empty">Reading.</p>
  {:else if files.length === 0}
    <p class="empty">No files. A note referencing one puts it here.</p>
  {:else}
    <ul class="rows">
      {#each files as path (path)}
        {@const by = referencedBy.get(path) ?? []}
        <li class:orphan={by.length === 0}>
          <button class="what" onclick={() => go.file(path)}>{path}</button>
          {#if by.length === 0}
            <!-- Dim rather than alarming: an unreferenced file is untidy, not
                 broken, and §02 keeps the accent for the live edge. -->
            <span class="by">referenced by nothing</span>
          {:else}
            <span class="by">
              {#each by.slice(0, 2) as note, n (note)}
                {n > 0 ? ' · ' : ''}<button class="ref" onclick={() => go.note(note)}
                  >{titleOf(note)}</button
                >
              {/each}{by.length > 2 ? ` +${by.length - 2}` : ''}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
.attachments {
  max-width: var(--measure-box);
  margin: 0 auto;
  padding: var(--s5) var(--s5) var(--s6);
}

.stamp {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--s3);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}
/* A UA stylesheet resets `text-transform` and `letter-spacing` on form controls.
   See Today.svelte, where deleting these as redundant cost the label its case. */
.back {
  flex: none;
  white-space: nowrap;
  text-transform: uppercase;
  letter-spacing: var(--track-micro);
}
.back:hover,
.what:hover,
.ref:hover {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.back:focus-visible,
.what:focus-visible,
.ref:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
}

.title {
  display: flex;
  align-items: baseline;
  gap: var(--s3);
  padding: var(--s1) 0 var(--s4);
  border-bottom: var(--hairline) solid var(--line);
}
.title h2 {
  font-size: var(--text-title);
  font-weight: 700;
  color: var(--hi);
}
.meta {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}

.empty {
  padding: var(--s5) 0;
  color: var(--dim);
}

.rows {
  list-style: none;
}
.rows li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--s3);
  padding: var(--s3) 0;
  border-bottom: var(--hairline) solid var(--line);
}
.what {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.by,
.ref {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
  white-space: nowrap;
}
.rows li.orphan .what {
  color: var(--dim);
}
</style>
