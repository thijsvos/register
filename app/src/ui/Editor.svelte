<script lang="ts">
import { fileUrl } from '../core/api'
import { bodyOffset } from '../core/frontmatter'
import { misses } from '../core/media.svelte'
import { offline } from '../core/offline'
import { resolveSrc } from '../core/paths'
import { vault } from '../core/store.svelte'
import type { EditorHandle } from '../editor'
import { setRenderMs } from '../lib/render.svelte'
import NoteHead from './NoteHead.svelte'
import { go } from './nav'
import { chrome } from './view.svelte'

let parent: HTMLDivElement | null = $state(null)
let handle = $state<EditorHandle | null>(null)
/** The path the editor currently holds, so a note switch is distinguishable
 *  from an external edit to the same note. */
let loaded: string | null = null

// CodeMirror is a lazy chunk (§04). The shell paints, the frame is usable, and
// ~98 kB gz of editor arrives only when a note is actually opened.
$effect(() => {
  const target = parent
  const path = vault.openPath
  if (target === null || path === null) return

  let live = true
  void import('../editor').then(({ createEditor }) => {
    if (!live || handle !== null) return
    // Where this note was left, if it has been read this session. Raising
    // TODAY, SETTINGS or a media surface destroys this component — they are
    // alternatives in one `{#if}` — so without this, clicking an image and
    // coming back rebuilt the note at the top of it.
    const held = chrome.placeIn(path)
    handle = createEditor({
      parent: target,
      doc: vault.buffer,
      caret: held?.caret ?? bodyOffset(vault.buffer),
      // Zero rather than absent: the top is where an unread note starts, and
      // `exactOptionalPropertyTypes` will not take an explicit undefined.
      scroll: held?.scroll ?? 0,
      host: wikiHost(),
      onEdit: (doc) => vault.edit(doc),
      onRender: setRenderMs,
      // An export is the same surface, reading (§12). Nothing else in this
      // component changes: the caret memory, the outline's reveal and the
      // wikilink host all work on a document that cannot be typed into.
      readOnly: offline,
    })
    loaded = path
    handle.focus()
  })

  return () => {
    live = false
    if (handle !== null && loaded !== null) chrome.rememberPlace(loaded, handle.place())
    handle?.destroy()
    handle = null
    loaded = null
  }
})

// Two different operations, and conflating them is the bug this guards against.
// A different note is a full load with the caret at the top; the same note
// changing underneath is a minimal diff that keeps the caret where it was.
$effect(() => {
  const editor = handle
  const path = vault.openPath
  const text = vault.buffer
  if (editor === null || path === null) return

  if (path !== loaded) {
    // The note being left keeps its place too, so this works in both
    // directions: the index, a wikilink and ⌘K all come back to where you were.
    if (loaded !== null) chrome.rememberPlace(loaded, editor.place())
    const held = chrome.placeIn(path)
    // Past the frontmatter: at offset 0 the first keystroke lands above the
    // opening fence and the note stops being a note.
    editor.load(text, held?.caret ?? bodyOffset(text), held?.scroll)
    loaded = path
    // Opening a note must put the caret in it. Without this the caret stays on
    // <body>, `isTyping` reports false, and every letter typed goes to the
    // global keymap instead — `n` creates a note, `i` inverts the theme. The
    // only route back is Tab, which walks one stop per sidebar row.
    editor.focus()
  } else {
    // Deliberately not on sync: an agent's edit arriving must not steal the
    // caret from whatever the user is doing elsewhere.
    editor.sync(text)
  }
})

// Somebody asking for the caret: an OUTLINE row with an offset, or Enter from
// the frame with none. Tracked by nonce rather than consumed, because clearing
// state from inside the effect that reads it costs a second pass — and a stale
// request must not re-fire when the editor is rebuilt for a different note.
let answered = 0
$effect(() => {
  const target = chrome.focusAt
  const editor = handle
  if (target === null || editor === null || target.nonce === answered) return
  answered = target.nonce
  if (target.position === null) editor.focus()
  else editor.reveal(target.position)
})

// ⌘K's FOLLOW · LINK, which is the palette naming the key `Mod-Enter` already
// carries. Tracked by nonce for `focusAt`'s reason: asking twice in a row has to
// act twice, and a stale request must not re-fire when the editor is rebuilt.
let followed = 0
$effect(() => {
  const asked = chrome.followAt
  const editor = handle
  if (asked === 0 || editor === null || asked === followed) return
  followed = asked
  // Said rather than left silent: the command is offered whenever a note is
  // open, because nothing outside the editor can see where the caret is.
  if (!editor.follow()) vault.notice = 'No link at the caret.'
})

// The vault index changes under a still document — an agent can create the note
// a dotted wikilink points at — so the callbacks are swapped rather than baked
// in, and the decorations rebuild when they change.
$effect(() => {
  void vault.tree
  // …and `openPath`, because a relative `![alt](src)` resolves against the note
  // that holds it: without this the host still points at the previous note and
  // every relative reference in the new one loads from the wrong folder.
  void vault.openPath
  // …and a failed load, which is the only way a missing target becomes known.
  // Reading it here is what turns the reference inert once its image 404s.
  void misses.version
  handle?.setHost(wikiHost())
})

function wikiHost() {
  // `openPath` is read here rather than inside the editor because the editor is
  // handed a document, not a location — it has never known which note it holds.
  const from = vault.openPath
  return {
    exists: (target: string) => vault.resolve(target) !== null,
    open: (target: string) => go.follow(target),
    fileUrl: (src: string) => {
      if (from === null) return null
      const path = resolveSrc(from, src)
      // Passed through as is, the empty string included. That is an export
      // saying it did not carry the file, and an `<img src="">` fetches nothing
      // and reports an error — so the reference is demoted by the same path a
      // served page's missing target takes, rather than by a second one.
      return path === null ? null : fileUrl(path)
    },
    openFile: (src: string) => {
      if (from === null) return
      const path = resolveSrc(from, src)
      if (path !== null) go.file(path)
    },
    fileGone: (src: string) => {
      if (from === null) return
      const path = resolveSrc(from, src)
      if (path !== null) misses.mark(path)
    },
    fileMissing: (src: string) => {
      if (from === null) return false
      const path = resolveSrc(from, src)
      return path !== null && misses.missing(path)
    },
  }
}
</script>

<div class="doc">
  <NoteHead />
  <div class="editor" bind:this={parent}></div>
</div>

<style>
/* Two rows: the header takes what it needs and the editor takes the rest.
   `minmax(0, 1fr)` rather than `1fr`, or the CodeMirror scroller sizes to its
   whole document and the note scrolls the pane instead of scrolling itself. */
.doc {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.editor {
  min-height: 0;
}
</style>
