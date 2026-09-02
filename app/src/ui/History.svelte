<script lang="ts">
import { getHistory, getLedger, getVersion, type Version } from '../core/api'
import { diffLines } from '../core/diff'
import { when, whoLabel } from '../core/ledger'
import { basename } from '../core/paths'
import { vault } from '../core/store.svelte'
import { go, traverse } from './nav'
import { chrome } from './view.svelte'

/**
 * §02b Screen 11 — HISTORY: what happened to a note, or to the vault, and who
 * did it.
 *
 * One component, two questions. Given a path it lists that note's versions,
 * newest first, followed across the app's own moves; given none it is the
 * ledger — one row per note per commit, for the whole vault. Either way a row
 * opens as *then* against *now*, the same hairline table Screen 4 draws for a
 * conflict but read-only, and [R] writes then back through the same guarded
 * PUT as any save.
 *
 * Nothing here is stored. The history is the vault's own git log, read on
 * demand for the reason Screen 9 reads the trash on demand: it is a screen you
 * visit, not state the frame draws, and a `git log` at boot would put a
 * subprocess in the 500 ms start-up path.
 *
 * Who is never a guess. A checkpoint says `you`, `outside` or both, meaning
 * through this app or not; a commit made by hand is named by its author and
 * its subject, exactly as git holds them.
 */
let { path }: { path: string | null } = $props()

let rows = $state<Version[]>([])
let loaded = $state(false)
/** The version open against now, or null while the list is showing. */
let chosen = $state<Version | null>(null)
/** Its body, null until it lands. */
let then = $state<string | null>(null)
let restoring = $state(false)
let panel = $state<HTMLElement | null>(null)

async function load(): Promise<void> {
  try {
    rows = path === null ? await getLedger() : await getHistory(path)
  } catch (error) {
    vault.notice = error instanceof Error ? error.message : String(error)
  }
  loaded = true
}

$effect(() => {
  // Re-read when the question changes: a note's history and the ledger are
  // one component with different props.
  void path
  loaded = false
  chosen = null
  then = null
  void load()
})

// The diff replaces the list, and the row that had focus with it, so focus
// would fall to <body> — where [R] and a stepping-back Escape reach nothing.
// As soon as a version is chosen, not once its body lands: an Escape typed
// while it is still being read has to step back too.
$effect(() => {
  if (chosen !== null) panel?.focus()
})

async function open(row: Version): Promise<void> {
  chosen = row
  then = null
  try {
    then = await getVersion(row.sha, row.path)
  } catch (error) {
    vault.notice = error instanceof Error ? error.message : String(error)
    chosen = null
  }
}

/**
 * The note a row is about, as it is named now.
 *
 * A note's history follows it across the app's moves, so an old row may carry
 * an old name — the note is the one this screen was opened on. The ledger has
 * no such anchor and names the path as the commit did.
 */
function current(row: Version): string {
  return path ?? row.path
}

/** The ref the restore points at, or the filename when the note has none. */
function target(row: Version): string {
  const now = current(row)
  return vault.tree.find((entry) => entry.path === now)?.ref ?? basename(now)
}

/**
 * What the note says now: the buffer when it is the open note, else the
 * corpus, else nothing — a note that has since been removed diffs against
 * empty, and a restore of it is a create.
 */
let now = $derived.by(() => {
  if (chosen === null) return null
  const here = current(chosen)
  if (vault.openPath === here) return vault.buffer
  return vault.corpus[here]?.body ?? ''
})

let lines = $derived(
  chosen === null || then === null || now === null ? [] : diffLines(then, now),
)
let differs = $derived(lines.filter((line) => line.kind === 'change').length)

/** One level back: from the diff to the list, from the list to the note. */
function back(): void {
  if (chosen !== null) {
    chosen = null
    then = null
  } else {
    chrome.showNotes()
  }
}

async function restore(): Promise<void> {
  if (chosen === null || then === null || restoring) return
  restoring = true
  const here = current(chosen)
  const restored = await vault.restore(here, then)
  restoring = false
  if (restored) go.note(here)
}

function onKey(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  // Escape steps back before the global keymap gets to leave the view;
  // `preventDefault` is how that keymap is told something nearer took it.
  if (event.key === 'Escape' && chosen !== null) {
    event.preventDefault()
    back()
    return
  }
  if (event.key.toLowerCase() === 'r' && chosen !== null) {
    event.preventDefault()
    void restore()
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="history" onkeydown={onKey}>
  <div class="head">
    <div class="stamp">
      <span>{path === null ? 'Ledger · the vault, newest first' : 'History · who changed this note'}</span>
      <!-- §01: "every control shows its key". Escape leaves any raised view;
           here it first steps back from a version to the list. -->
      <button class="back" onclick={back}>[Esc] {chosen === null ? 'back' : 'list'}</button>
    </div>
    <div class="title">
      <h2>{path === null ? 'Ledger' : basename(path)}</h2>
      <span class="meta">
        {rows.length === 0 ? '' : plural(rows.length, path === null ? 'change' : 'version')}
      </span>
    </div>
  </div>

  {#if !loaded}
    <p class="empty">Reading.</p>
  {:else if rows.length === 0}
    <!-- §02b Screen 3's voice: what is true, then what to do about it. Two
         truths, told apart: no repository, or a repository nothing has
         written to yet. -->
    <p class="empty">
      {vault.git === null
        ? 'No history. This vault is not a git repository of its own, so nothing records it.'
        : 'No history yet. Checkpoints record the vault after 90 s of quiet.'}
    </p>
  {:else if chosen === null}
    <div class="rows">
      {#each rows as row (row.sha + row.path)}
        <button class="row" onclick={() => open(row)} onkeydown={traverse}>
          <span class="stampcol">{when(row.at)}</span>
          <span class="who" class:outside={row.who !== 'you'}>{whoLabel(row)}</span>
          <span class="what">{path === null ? row.path : row.subject}</span>
        </button>
      {/each}
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="version" tabindex="-1" bind:this={panel}>
      <div class="heads">
        <div class="colhead">◉ Then · {when(chosen.at)} · {whoLabel(chosen)}</div>
        <div class="colhead">
          ◐ Now{vault.openPath === current(chosen) && vault.dirty ? ' · unsaved' : ''}
        </div>
      </div>
      {#if then === null}
        <p class="empty">Reading that version.</p>
      {:else}
        <div class="lines">
          {#each lines as line, at (at)}
            <div class="line">
              <div class="cell">
                <span class="mark">{line.kind === 'same' ? '=' : '−'}</span>
                <span class="text" class:void={line.local === null}>{line.local ?? '∅ (empty)'}</span>
              </div>
              <div class="cell">
                <span class="mark">{line.kind === 'same' ? '=' : '+'}</span>
                <span class="text" class:void={line.disk === null}>{line.disk ?? '∅ (empty)'}</span>
              </div>
            </div>
          {/each}
        </div>
        <div class="foot">
          <span class="gate">
            {differs === 0 ? '[ nothing differs ]' : `[ ${plural(differs, 'line')} differ${differs === 1 ? 's' : ''} ]`}
          </span>
          <!-- Through `vault.restore`: the same guarded PUT as a save, so a
               note that moved on since this was read is a refusal, and a note
               open with unsaved text is refused before anything is sent. -->
          <button class="write" disabled={restoring || differs === 0} onclick={restore}>
            ‹[R] Restore then → {target(chosen)}›
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
.history {
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
/* A UA stylesheet resets `text-transform` and `letter-spacing` on form controls,
   so a <button> inherits neither from the row it sits in — see Today.svelte. */
.back {
  flex: none;
  white-space: nowrap;
  text-transform: uppercase;
  letter-spacing: var(--track-micro);
}
.back:hover,
.row:hover {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.back:focus-visible,
.row:focus-visible,
.write:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
}
.version:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-inset);
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
  max-width: var(--measure);
  color: var(--dim);
}

/* §02b nav row: one line, three columns, hairline under. A button because it
   is one — Enter opens it — and `traverse` gives it j/k like every other row. */
.row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: baseline;
  gap: var(--s3);
  width: 100%;
  padding: var(--s3) 0;
  border-bottom: var(--hairline) solid var(--line);
  text-align: left;
  font-size: var(--text-body);
  line-height: var(--lh-body);
}
.stampcol,
.who {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* The accent is for "what changed under you" (§02, ruled): a row the app did
   not write is exactly that. Hover inverts it with the rest of the row. */
.who.outside {
  color: var(--signal);
}
.row:hover .stampcol,
.row:hover .who,
.row:hover .who.outside {
  color: var(--sel-fg);
}
.what {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Then against now: Screen 4's two columns and hairline gap, read-only. */
.heads,
.line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--hairline);
  background: var(--line);
}
.heads {
  border-top: var(--hairline) solid var(--line);
  border-bottom: var(--hairline) solid var(--line);
}
.colhead {
  background: var(--bg);
  padding: var(--pane-y) var(--s2);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}
.lines {
  border-bottom: var(--hairline) solid var(--line);
}
.cell {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  background: var(--bg);
  padding: var(--s1) var(--s2);
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
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.void {
  color: var(--dim);
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
/* §02b: "Disabled = --dim text, no hover, cursor not-allowed." */
.write:disabled {
  color: var(--dim);
  border-color: var(--dim);
  cursor: not-allowed;
}
</style>
