<script lang="ts">
import { type Hit, highlight, search, snippet } from '../../core/search'
import { vault } from '../../core/store.svelte'
import { go } from '../nav'
import { chrome } from '../view.svelte'
import { type Command, matchCommands, templateChoices } from './commands'

/** What the list can show before it scrolls past being useful. */
const LIMIT = 20

let query = $state('')
let selected = $state(0)
let input: HTMLInputElement | null = $state(null)
let list: HTMLDivElement | null = $state(null)

/**
 * Real full-text search over the corpus (§02b: "⌘K must run real full-text
 * search over the corpus, not filter a fixed command list").
 *
 * Syncing here as well as at boot keeps the list live while the palette is open,
 * so an agent's write appears in the results — and because the sync reads the
 * tree and the corpus, this derived re-runs when either moves.
 */
let notes = $derived.by(() => {
  search.sync(vault.tree, vault.corpus)
  return search.find(query, LIMIT)
})

let commands = $derived(matchCommands(query))
let templates = $derived(templateChoices(query))
let total = $derived(notes.length + commands.length + templates.length)

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

/** The body excerpt §02b Screen 2 draws beside the title, or '' if none. */
function excerpt(hit: Hit): string {
  const held = vault.corpus[hit.entry.path]
  return held === undefined ? '' : snippet(held.body, hit.terms)
}

/** Set when the palette navigated, so its focus-restore stands down and the
 *  editor gets the caret instead. */
let navigated = false

function choose(index: number) {
  const note = notes[index]
  if (note !== undefined) {
    navigated = true
    chrome.closePalette()
    go.note(note.entry.path)
    return
  }

  const command: Command | undefined = commands[index - notes.length]
  if (command !== undefined) {
    // A command whose whole effect is where focus lands has to stand the restore
    // down for the same reason a note navigation does, or it is undone by the
    // teardown one microtask after it runs.
    if (command.takesFocus === true) navigated = true
    chrome.closePalette()
    void command.run()
    return
  }

  const template = templates[index - notes.length - commands.length]
  if (template !== undefined) {
    // Lands the caret in the new note, like every other route into one.
    navigated = true
    chrome.closePalette()
    go.create(template.title, template.path)
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

/**
 * Split a command label so the matched run carries the signal colour (§02b).
 *
 * Subsequence, unlike the note rows: commands are a fixed list matched the way a
 * palette is expected to behave (`tgi` finds TOGGLE INSPECTOR), while notes come
 * back from the index with the whole terms they actually matched.
 */
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
        {#each notes as note, index (note.entry.path)}
          {@const snip = excerpt(note)}
          <button
            class="row note"
            role="option"
            id="pal-row-{index}"
            class:sel={selected === index}
            aria-selected={selected === index}
            onmousemove={() => {
              selected = index
            }}
            onclick={() => choose(index)}
          >
            <span class="ref">{note.entry.ref ?? '—'}</span>
            <span class="name">
              {#each highlight(note.entry.title ?? note.entry.path, note.terms) as part, n (n)}
                <span class:hit={part.hit}>{part.text}</span>
              {/each}
            </span>
            {#if snip === ''}
              <span class="hint">{vault.words(note.entry.path) ?? '—'}</span>
            {:else}
              <span class="snip">
                {#each highlight(snip, note.terms) as part, n (n)}
                  <span class:hit={part.hit}>{part.text}</span>
                {/each}
              </span>
            {/if}
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

      {#if templates.length > 0}
        <div class="section">New from template · {templates.length}</div>
        {#each templates as template, index (template.path)}
          {@const position = notes.length + commands.length + index}
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
            <span class="name">{template.name}</span>
            <span class="hint">{template.title}</span>
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
/* §02b Screen 2 draws a note row as ref · title · excerpt, so the title takes
   the space it needs and the excerpt takes what is left. A command row keeps the
   right column at its natural width — a key hint must never be elided. */
.row.note {
  grid-template-columns: var(--nav-ref) minmax(0, auto) minmax(0, 1fr);
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
.row.sel .hint,
.row.sel .snip {
  color: var(--sel-fg);
}
.name,
.snip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.snip {
  color: var(--dim);
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
