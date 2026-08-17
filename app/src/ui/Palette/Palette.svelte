<script lang="ts">
import { tick } from 'svelte'
import { DEFAULT_FOLDER } from '../../core/refs'
import { type Hit, highlight, search, snippet } from '../../core/search'
import { vault } from '../../core/store.svelte'
import { notesUnder } from '../../core/tree'
import { enterIndex, go, traverse } from '../nav'
import { chrome, type Pending } from '../view.svelte'
import { type Command, folderChoices, matchCommands, templateChoices } from './commands'

/** What the list can show before it scrolls past being useful. */
const LIMIT = 20

// Seeded rather than always empty: the component mounts on open, so this reads
// whatever asked for the surface. Everything else opens it with nothing.
let query = $state(chrome.paletteSeed)
let selected = $state(0)
let input: HTMLInputElement | null = $state(null)
let list: HTMLDivElement | null = $state(null)
/** The destructive answer, which takes focus while a deletion is armed. */
let confirm: HTMLButtonElement | null = $state(null)

/**
 * Real full-text search over the corpus (§02b: "⌘K must run real full-text
 * search over the corpus, not filter a fixed command list").
 *
 * Syncing here as well as at boot keeps the list live while the palette is open,
 * so an agent's write appears in the results — and because the sync reads the
 * tree and the corpus, this derived re-runs when either moves.
 */
let notes = $derived.by(() => {
  // An armed deletion owns the whole surface: a list of notes under a question
  // about deleting one of them is an invitation to press Enter on the wrong row.
  if (chrome.pending !== null) return []
  search.sync(vault.tree, vault.corpus)
  return search.find(query, LIMIT)
})

let commands = $derived(chrome.pending === null ? matchCommands(query) : [])
let templates = $derived(chrome.pending === null ? templateChoices(query) : [])
// Existing folders the query could mean. Self-limiting: choosing one types a
// trailing separator, which stops matching, so these clear themselves once the
// destination is settled and what follows is a title.
let folderRows = $derived(chrome.pending === null ? folderChoices(query) : [])
let total = $derived(
  notes.length + commands.length + folderRows.length + templates.length,
)

// The selection must never point past the end when the query narrows.
$effect(() => {
  if (selected >= total) selected = Math.max(0, total - 1)
})

// Arming moves focus onto the answer, disarming puts it back in the box.
//
// Arming can happen while the palette is *already* open — choosing DELETE ·
// FOLDER with the mouse — and the row that was clicked is gone by the next
// frame. Focus fell to <body>, and the question on screen could not be answered
// with the keyboard at all: measured as a confirm that sat there ignoring
// Enter. The mount-time effect below does not cover it, because the component
// is never remounted.
//
// `confirm` is read after `pending`, so this re-runs when the button binds.
$effect(() => {
  if (chrome.pending === null) {
    selected = 0
    input?.focus()
    return
  }
  confirm?.focus()
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

/**
 * What is about to happen, in a sentence, where the search box would be.
 *
 * The box was there first and it was doing nothing: the query could not reach
 * the two answers, so it was a text field on a destructive question that
 * accepted typing and ignored it. It was also the only focusable thing on the
 * surface, which is why removing it moves the keyboard onto the buttons.
 *
 * The path rather than the title, because the path is unambiguous and is what
 * you would go looking for in `.register/trash/` afterwards.
 */
function question(pending: Pending): string {
  if (pending.kind === 'note') return `Delete ${pending.path}?`
  const notes = `${pending.notes} ${pending.notes === 1 ? 'note' : 'notes'}`
  // "and anything else in the folder", because the count is what the INDEX can
  // see and the INDEX draws notes. A folder holding twenty images reports three,
  // and a bare number reads as complete — so the sentence states the fact rather
  // than the server being asked for a true tally inside a keystroke.
  return `Delete ${pending.path} and everything under it? ${notes}, and anything else in the folder.`
}

/**
 * Carry out the armed deletion.
 *
 * Deliberately does *not* set `navigated`. The focus-restore below then runs and
 * aims at the row this was launched from: on success that row is already gone
 * and the restore is a silent no-op, so `enterIndex` places the caret instead;
 * on failure the row is still there and getting it back is exactly right.
 */
async function answer(pending: Pending): Promise<void> {
  const rev = pending.rev ?? undefined
  const gone =
    pending.kind === 'note'
      ? await vault.trashNote(pending.path, rev)
      : await vault.trashFolder(pending.path, rev)

  // The vault moved while the question was on screen — an agent wrote, or our
  // own save landed — so the confirm was describing a folder that has since
  // changed. §04 Rev X refuses it, and the answer is to **ask again** rather than
  // to report a failure: the reader still wants to delete this, they just have
  // not been shown what it holds now.
  //
  // Re-asking rather than failing is what makes the guard usable at all. Any
  // write bumps the revision, including one of our own — so a confirm drawn a
  // moment before the debounced save landed would otherwise refuse against
  // nobody but the reader themselves.
  if (gone === 'moved') {
    await vault.refresh()
    chrome.arm({
      ...pending,
      notes:
        pending.kind === 'folder' ? notesUnder(vault.tree, pending.path) : pending.notes,
      rev: vault.rev,
    })
    vault.notice = 'The vault changed. This is what it holds now.'
    return
  }

  // Closed only once the answer is settled: closing first, as this used to, left
  // nothing on screen to re-arm.
  chrome.closePalette()
  // §01's mouse-free promise breaks on the *next* keystroke, not this one, which
  // is where it is hardest to notice. `enterIndex` is a no-op with no INDEX.
  //
  // After the redraw, not before. A deletion can *re-key* the index rather than
  // only shorten it: take the last loose note out of `notes/` and it holds one
  // folder and nothing else, so the chain compacts — the row keyed `notes` is
  // destroyed and one keyed `notes/projects` takes its place. Focusing first
  // lands on an element the flush is about to remove, and focus falls to
  // <body>. Measured on CI, where the flush happens to run after this call;
  // locally it ran before, which is why the suite was green either way.
  if (gone) {
    await tick()
    enterIndex('first')
  }
}

/**
 * The keys the two answers own, now that no text field owns them.
 *
 * Enter and Space are the button's own and need nothing. Tab cycles between the
 * two rather than leaving: `aria-modal` says focus is trapped and nothing
 * enforces that by itself — a Tab that walked out would leave an open confirm
 * with focus behind it. Everything else is `traverse`, the same ↑↓/j–k every nav
 * row in the app takes (§02b).
 *
 * **Escape is deliberately not here.** The window keymap already closes the
 * palette from anywhere precisely so a stray focus cannot make an open modal
 * unclosable, and a branch here would never run in any reachable state —
 * measured: deleting it changed nothing the suite could see. An unfalsifiable
 * branch reads as care and tests as nothing.
 */
function onAnswerKey(event: KeyboardEvent): void {
  if (event.key === 'Tab') {
    event.preventDefault()
    const row = event.currentTarget
    if (!(row instanceof HTMLElement)) return
    // Two rows, so "the other one" is the whole cycle in either direction.
    const other = row.nextElementSibling ?? row.previousElementSibling
    if (other instanceof HTMLElement) other.focus()
    return
  }
  traverse(event)
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
    void command.run(query)
    return
  }

  const folder = folderRows[index - notes.length - commands.length]
  if (folder !== undefined) {
    // Completes rather than creates. Nothing is written by picking a place to
    // write it, and the palette stays open so the title can follow — which is
    // also why the caret goes back to the end of the box.
    query = `${folder.path}/`
    selected = 0
    input?.focus()
    return
  }

  const template = templates[index - notes.length - commands.length - folderRows.length]
  if (template !== undefined) {
    // Lands the caret in the new note, like every other route into one.
    navigated = true
    chrome.closePalette()
    go.create(template.title, template.path, template.folder ?? undefined)
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
  <!--
    `alertdialog` while a deletion is armed: it is a modal that interrupts to
    acquire an answer, which is the role's own definition, and it is described
    by the question rather than by a list of results.
  -->
  <div
    class="pal"
    role={chrome.pending === null ? 'dialog' : 'alertdialog'}
    aria-modal="true"
    aria-label={chrome.pending === null ? 'Command and search' : 'Confirm deletion'}
    aria-describedby={chrome.pending === null ? undefined : 'pal-question'}
  >
    <div class="head">
      <span>{chrome.pending === null ? 'Command & search' : 'Confirm deletion'}</span
      ><span class="esc">[ESC]</span>
    </div>

    {#if chrome.pending !== null}
      <p class="question" id="pal-question">{question(chrome.pending)}</p>
    {:else}
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
    {/if}

    <div
      class="list"
      bind:this={list}
      role={chrome.pending === null ? 'listbox' : undefined}
      aria-label={chrome.pending === null ? 'Results' : undefined}
      id="pal-results"
    >
      {#if chrome.pending !== null}
        {@const pending = chrome.pending}
        <!--
          Two real buttons, not options in a listbox. With no text field there is
          nothing for `aria-activedescendant` to hang off, and focus *is* the
          selection — the same model every nav row in the app already uses.
        -->
        <button
          class="row answer"
          bind:this={confirm}
          onclick={() => answer(pending)}
          onkeydown={onAnswerKey}
        >
          <span class="ref"></span>
          <span class="name">CONFIRM · TRASH</span>
          <span class="hint">↵</span>
        </button>
        <button
          class="row answer"
          onclick={() => chrome.closePalette()}
          onkeydown={onAnswerKey}
        >
          <span class="ref"></span>
          <span class="name">CANCEL</span>
          <span class="hint">ESC</span>
        </button>
      {/if}

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
              {#if command.detail !== undefined}
                <span class="detail">{command.detail}</span>
              {/if}
            </span>
            <span class="hint">{command.keys}</span>
          </button>
        {/each}
      {/if}

      {#if folderRows.length > 0}
        <div class="section">Folders · {folderRows.length}</div>
        {#each folderRows as folder, index (folder.path)}
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
            <span class="name">
              {#each segments(folder.path, query) as part, n (n)}
                <span class:hit={part.hit}>{part.text}</span>
              {/each}
            </span>
            <span class="hint">{folder.notes} · new note here</span>
          </button>
        {/each}
      {/if}

      {#if templates.length > 0}
        <div class="section">New from template · {templates.length}</div>
        {#each templates as template, index (template.path)}
          {@const position =
            notes.length + commands.length + folderRows.length + index}
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
            <span class="hint"
              >{template.folder ?? DEFAULT_FOLDER}/ · {template.title}</span
            >
          </button>
        {/each}
      {/if}

      {#if total === 0 && chrome.pending === null}
        <p class="empty">No notes match. [N] creates one.</p>
      {/if}
    </div>

    <div class="foot">
      {#if chrome.pending === null}
        <span>↑↓ navigate · ↵ open/run</span><span>{total} results</span>
      {:else}
        <!-- §04 never hard-deletes, and a confirm that does not say so asks the
             reader to be braver than the operation requires. -->
        <span>↵ confirm · ESC cancel</span><span>Recoverable in .register/trash/</span>
      {/if}
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
  /* vw resolves against the unzoomed viewport, so divided back like --pal-top
     and --pal-max. Left inline rather than tokenised: it is the palette's own
     margin against a narrow window, not a §02 dimension. */
  width: min(var(--pal-width), calc(92vw / var(--ui-scale)));
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
/* The question, in the space the search box used to take. Same hairline and the
   same padding, so the frame's rhythm is unchanged — what is gone is a field
   that accepted typing on a destructive question and ignored it. */
.question {
  padding: var(--s3);
  border-bottom: var(--hairline) solid var(--line);
  font-size: var(--text-body);
  color: var(--fg);
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
/* `:focus`, not `:focus-visible`. These two are the only focusable things on the
   surface and the focused one is the answer Enter will give, so it has to read
   as chosen however the palette was armed — and arming from a *click* leaves
   `:focus-visible` unmatched, which would draw the question with no visible
   answer selected. §02: keep focus rings visible. */
.row.answer:focus {
  background: var(--sel-bg);
  color: var(--sel-fg);
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-inset);
}
.row.answer:focus .hint {
  color: var(--sel-fg);
}
.row.sel {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.ref,
.detail {
  margin-left: var(--s3);
  color: var(--dim);
}
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
