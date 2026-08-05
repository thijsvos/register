<script lang="ts">
import type { Entry } from '../../core/api'
import { vault } from '../../core/store.svelte'
import { chrome } from '../view.svelte'
import { type Command, fuzzyScore, matchCommands } from './commands'

let query = $state('')
let selected = $state(0)
let input: HTMLInputElement | null = $state(null)
let list: HTMLDivElement | null = $state(null)

/**
 * Notes matched on title, ref and path.
 *
 * §02b Screen 2 promises full text over the corpus; that arrives in P6 with
 * MiniSearch (§04). Until then this matches what the tree already holds rather
 * than pretending to search bodies it has not indexed.
 */
let notes = $derived(
  vault.tree
    .map((entry) => ({
      entry,
      score: bestScore(entry, query),
    }))
    .filter((row): row is { entry: Entry; score: number } => row.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 20)
    .map((row) => row.entry),
)

let commands = $derived(matchCommands(query))
let total = $derived(notes.length + commands.length)

// The selection must never point past the end when the query narrows.
$effect(() => {
  if (selected >= total) selected = Math.max(0, total - 1)
})

// Focus goes into the palette on open and back where it came from on close.
// Without the restore, the first command ends with focus on <body> and every
// subsequent key goes nowhere — which breaks §01's mouse-free promise on the
// second action rather than the first, so it is easy to miss.
$effect(() => {
  const before = document.activeElement
  input?.focus()
  return () => {
    if (navigated) return
    if (before instanceof HTMLElement && before.isConnected) before.focus()
  }
})

// §02b: "selection follows ↑↓, scrolls into view".
$effect(() => {
  void selected
  list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
})

function bestScore(entry: Entry, text: string): number | null {
  const candidates = [entry.title ?? '', entry.ref ?? '', entry.path]
  let best: number | null = null
  for (const candidate of candidates) {
    const score = fuzzyScore(candidate, text)
    if (score !== null && (best === null || score < best)) best = score
  }
  return best
}

/** Set when the palette navigated, so its focus-restore stands down and the
 *  editor gets the caret instead. */
let navigated = false

function choose(index: number) {
  const note = notes[index]
  if (note !== undefined) {
    navigated = true
    chrome.closePalette()
    void vault.open(note.path)
    return
  }
  const command: Command | undefined = commands[index - notes.length]
  if (command !== undefined) {
    chrome.closePalette()
    void command.run()
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    chrome.closePalette()
    return
  }
  // Tab moves the selection rather than escaping the dialog. aria-modal says
  // focus is trapped; nothing enforces that by itself, and a Tab that walked
  // out would leave an open modal with focus behind it.
  const forward = event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)
  const back = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)

  if (forward) {
    event.preventDefault()
    selected = total === 0 ? 0 : (selected + 1) % total
    return
  }
  if (back) {
    event.preventDefault()
    selected = total === 0 ? 0 : (selected - 1 + total) % total
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    choose(selected)
  }
}

/** Split a label so the matched run can carry the signal colour (§02b). */
function segments(text: string, needle: string): { text: string; hit: boolean }[] {
  if (needle === '') return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const out: { text: string; hit: boolean }[] = []
  let at = 0
  for (const character of needle.toLowerCase()) {
    const found = lower.indexOf(character, at)
    if (found === -1) break
    if (found > at) out.push({ text: text.slice(at, found), hit: false })
    out.push({ text: text.slice(found, found + 1), hit: true })
    at = found + 1
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}
</script>

<!-- Click-through on the scrim closes; the dialog stops the propagation. -->
<div
  class="scrim"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) chrome.closePalette()
  }}
>
  <div class="pal" role="dialog" aria-modal="true" aria-label="Command and search">
    <div class="head">
      <span>Command &amp; search</span><span class="esc">[ESC]</span>
    </div>

    <div class="entry">
      <span class="prompt" aria-hidden="true">›</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onKey}
        placeholder="Search notes or type a command…"
        aria-label="Search notes or type a command"
        role="combobox"
        aria-expanded="true"
        aria-controls="pal-results"
        aria-activedescendant={total === 0 ? undefined : `pal-row-${selected}`}
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    <div class="list" bind:this={list} role="listbox" aria-label="Results" id="pal-results">
      {#if notes.length > 0}
        <div class="section">Notes · {notes.length}</div>
        {#each notes as note, index (note.path)}
          <button
            class="row"
            role="option"
            id="pal-row-{index}"
            class:sel={selected === index}
            aria-selected={selected === index}
            onmousemove={() => {
              selected = index
            }}
            onclick={() => choose(index)}
          >
            <span class="ref">{note.ref ?? '—'}</span>
            <span class="name">
              {#each segments(note.title ?? note.path, query) as part, n (n)}
                <span class:hit={part.hit}>{part.text}</span>
              {/each}
            </span>
            <span class="hint">{vault.words(note.path) ?? '—'}</span>
          </button>
        {/each}
      {/if}

      {#if commands.length > 0}
        <div class="section">Commands · {commands.length}</div>
        {#each commands as command, index (command.id)}
          {@const position = notes.length + index}
          <button
            class="row"
            role="option"
            id="pal-row-{position}"
            class:sel={selected === position}
            aria-selected={selected === position}
            onmousemove={() => {
              selected = position
            }}
            onclick={() => choose(position)}
          >
            <span class="ref"></span>
            <span class="name">
              {#each segments(command.label, query) as part, n (n)}
                <span class:hit={part.hit}>{part.text}</span>
              {/each}
            </span>
            <span class="hint">{command.keys}</span>
          </button>
        {/each}
      {/if}

      {#if total === 0}
        <p class="empty">No notes match. [N] creates one.</p>
      {/if}
    </div>

    <div class="foot">
      <span>↑↓ navigate · ↵ open/run</span><span>{total} results</span>
    </div>
  </div>
</div>

<style>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: var(--pal-top);
  background: var(--scrim);
}

/* §02: "Emphasis is a double rule (border + offset outline)." */
.pal {
  width: min(var(--pal-width), 92vw);
  background: var(--bg);
  border: var(--hairline) solid var(--line);
  outline: var(--hairline) solid var(--line);
  outline-offset: var(--rule-offset);
}

.head,
.foot {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}
.head {
  padding: var(--s2) var(--s3);
  border-bottom: var(--hairline) solid var(--line);
}
.head span:first-child {
  color: var(--fg);
}
.foot {
  padding: var(--pane-y) var(--s3);
  border-top: var(--hairline) solid var(--line);
}

.entry {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: var(--s2) var(--s3);
  border-bottom: var(--hairline) solid var(--line);
}
/* §02b Input: "signal caret ›, no box — the label is the frame". */
.prompt {
  color: var(--signal);
  font-weight: 700;
}
input {
  flex: 1;
  font: inherit;
  font-size: var(--text-body);
  background: none;
  border: none;
  outline: none;
  color: var(--fg);
  caret-color: var(--signal);
}
input::placeholder {
  color: var(--dim);
}

.list {
  max-height: var(--pal-max);
  overflow-y: auto;
}
.section {
  padding: var(--pane-y) var(--s3) var(--s1);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}

/* §02b Palette row: fg on bg · --hover · inverse when selected, one at a time. */
.row {
  display: grid;
  grid-template-columns: var(--nav-ref) 1fr auto;
  gap: var(--s3);
  align-items: baseline;
  width: 100%;
  padding: var(--pane-y) var(--s3);
  text-align: left;
  font-size: var(--text-body);
}
.row:hover {
  background: var(--hover);
}
.row.sel {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.ref,
.hint {
  color: var(--dim);
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  font-variant-numeric: tabular-nums;
}
.row.sel .ref,
.row.sel .hint {
  color: var(--sel-fg);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* §02b: "Match is highlighted with the signal color." */
.hit {
  color: var(--signal);
}
.row.sel .hit {
  color: var(--sel-fg);
  font-weight: 700;
}

.empty {
  padding: var(--s4) var(--s3);
  font-size: var(--text-body);
  color: var(--dim);
}
</style>
