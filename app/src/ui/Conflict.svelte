<script lang="ts">
import { untrack } from 'svelte'
import { diffLines, merge, pending, type Side } from '../core/diff'
import { vault } from '../core/store.svelte'
import { go } from './nav'

/**
 * §02b Screen 4 · CONFLICT — "human vs disk, side by side, never a modal".
 *
 * Two revisions of one note, paired line by line, with a side chosen per line.
 * Nothing here is stored: the conflict *is* the two files, the table is derived
 * from the corpus the client already holds, and the merge is one guarded PUT
 * followed by the copy's deletion. "No revision is destroyed" is the frame's
 * promise and it is kept by that order, not by anything remembered here.
 *
 * Not a modal, so there is always a way out without merging — the index, ⌘K and
 * ⌘D are all still live behind it. That is why the frame draws no cancel.
 */

let { copy }: { copy: string } = $props()

let pair = $derived(vault.unresolved.find((one) => one.copy.path === copy) ?? null)

/** What you had typed, and what is on disk — null until the body has landed. */
let mine = $derived(pair === null ? null : (vault.corpus[copy]?.body ?? null))
let theirs = $derived.by(() => {
  if (pair === null) return null
  // A copy whose original was removed still has to be resolvable: it is the only
  // surviving revision, so it is diffed against nothing and the merge creates.
  if (pair.original === null) return ''
  return vault.corpus[pair.from]?.body ?? null
})

let rows = $derived(mine === null || theirs === null ? [] : diffLines(mine, theirs))

let chosen = $state<(Side | undefined)[]>([])

// A choice is an index into `rows`, so it cannot outlive the table. If the note
// moved on disk while you were choosing, the rows are rebuilt and the old
// decisions would land on different lines — which is the one way a merge tool
// can lose writing while looking like it worked.
$effect(() => {
  void rows
  untrack(() => {
    chosen = []
  })
})

let left = $derived(pending(rows, chosen))
let contested = $derived(rows.filter((row) => row.kind === 'change').length)
let merged = $derived(merge(rows, chosen))

/** What the action button points at — the ref if the note has one. */
let target = $derived(pair === null ? '' : (pair.original?.ref ?? basename(pair.from)))

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function pick(at: number, side: Side): void {
  const next = [...chosen]
  next[at] = side
  chosen = next
}

async function write(): Promise<void> {
  if (merged === null || pair === null) return
  const note = pair.from
  // The frame's action is "Write merge → 003", so it goes there.
  if (await vault.resolveConflict(copy, merged)) go.note(note)
}
</script>

<div class="conflict">
  <div class="stamp">{basename(copy)} · Unresolved</div>

  {#if pair === null}
    <p class="empty">
      Nothing to resolve. {basename(copy)} is not in the vault — it has been merged
      or removed already.
    </p>
  {:else if mine === null || theirs === null}
    <p class="empty">Reading both revisions.</p>
  {:else}
    <div class="heads">
      <div class="head">◐ Local (your buffer)</div>
      <div class="head">
        ◉ Disk ({pair.original === null ? 'removed' : 'agent write'})
      </div>
    </div>

    <div class="rows">
      {#each rows as row, at (at)}
        {#if row.kind === 'same'}
          <div class="row">
            <div class="cell"><span class="mark">=</span><span class="text">{row.local}</span></div>
            <div class="cell"><span class="mark">=</span><span class="text">{row.disk}</span></div>
          </div>
        {:else}
          <div class="row">
            <!-- §02b state matrix: a chosen cell is inverse video, the same
                 active state a nav row and a palette row use. -->
            <button
              class="cell pick"
              class:kept={chosen[at] === 'local'}
              aria-pressed={chosen[at] === 'local'}
              aria-label="Keep local: {row.local ?? 'nothing'}"
              onclick={() => pick(at, 'local')}
            >
              <span class="mark">−</span>
              <span class="text" class:void={row.local === null}>{row.local ?? '∅ (empty)'}</span>
              {#if chosen[at] === 'local'}<span class="kept-mark">◉ Kept</span>{/if}
            </button>
            <button
              class="cell pick"
              class:kept={chosen[at] === 'disk'}
              aria-pressed={chosen[at] === 'disk'}
              aria-label="Keep disk: {row.disk ?? 'nothing'}"
              onclick={() => pick(at, 'disk')}
            >
              <span class="mark">+</span>
              <span class="text" class:void={row.disk === null}>{row.disk ?? '∅ (empty)'}</span>
              {#if chosen[at] === 'disk'}<span class="kept-mark">◉ Kept</span>{/if}
            </button>
          </div>
        {/if}
      {/each}
    </div>

    <div class="foot">
      <span class="gate">
        {#if contested === 0}
          [ nothing differs ]
        {:else if left === 0}
          [ all lines chosen ]
        {:else}
          [ {left} of {contested} still to choose ]
        {/if}
      </span>
      <button class="write" disabled={merged === null} onclick={write}>
        ‹Write merge → {target}›
      </button>
    </div>
  {/if}
</div>

<style>
.conflict {
  padding: var(--s5) var(--s5) var(--s6);
}

.stamp {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
  padding-bottom: var(--s4);
}

/* Two equal columns, hairline between — the frame's ┬ rule. */
.heads,
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--hairline);
  background: var(--line);
}
.heads {
  border-top: var(--hairline) solid var(--line);
  border-bottom: var(--hairline) solid var(--line);
}
.head {
  background: var(--bg);
  padding: var(--pane-y) var(--s2);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}

.rows {
  border-bottom: var(--hairline) solid var(--line);
}

.cell {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  background: var(--bg);
  padding: var(--s1) var(--s2);
  text-align: left;
  font-size: var(--text-body);
  line-height: var(--lh-body);
  min-width: 0;
}
.mark {
  flex: none;
  width: var(--s3);
  color: var(--faint);
}
.text {
  flex: 1;
  min-width: 0;
  /* A diff line is chosen by reading it, so it wraps rather than truncating. */
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.void {
  color: var(--dim);
}

.pick:hover {
  background: var(--hover);
  cursor: pointer;
}
.pick:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-inset);
}
/* §02b: "Chosen cell is inverse + ◉ KEPT. No revision is destroyed." */
.pick.kept,
.pick.kept:hover {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.pick.kept .mark,
.pick.kept .void {
  color: var(--sel-fg);
}
.kept-mark {
  flex: none;
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
}

.foot {
  display: flex;
  align-items: baseline;
  gap: var(--s3);
  padding-top: var(--s4);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
}
.gate {
  flex: 1;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.write {
  flex: none;
  border: var(--hairline) solid var(--line);
  padding: var(--key-pad-y) var(--s2);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
}
.write:hover:not(:disabled) {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.write:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
}
/* §02b: "Disabled = --dim text, no hover, cursor not-allowed." */
.write:disabled {
  color: var(--dim);
  border-color: var(--dim);
  cursor: not-allowed;
}

.empty {
  padding: var(--s5) 0;
  max-width: var(--measure);
  font-size: var(--text-body);
  color: var(--dim);
}
</style>
