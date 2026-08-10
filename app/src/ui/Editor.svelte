<script lang="ts">
import { fileUrl } from '../core/api'
import { bodyOffset } from '../core/frontmatter'
import { resolveSrc } from '../core/paths'
import { vault } from '../core/store.svelte'
import type { EditorHandle } from '../editor'
import { setRenderMs } from '../lib/render.svelte'
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
    handle = createEditor({
      parent: target,
      doc: vault.buffer,
      caret: bodyOffset(vault.buffer),
      host: wikiHost(),
      onEdit: (doc) => vault.edit(doc),
      onRender: setRenderMs,
    })
    loaded = path
    handle.focus()
  })

  return () => {
    live = false
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
    // Past the frontmatter: at offset 0 the first keystroke lands above the
    // opening fence and the note stops being a note.
    editor.load(text, bodyOffset(text))
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

// The vault index changes under a still document — an agent can create the note
// a dotted wikilink points at — so the callbacks are swapped rather than baked
// in, and the decorations rebuild when they change.
$effect(() => {
  void vault.tree
  // …and `openPath`, because a relative `![alt](src)` resolves against the note
  // that holds it: without this the host still points at the previous note and
  // every relative reference in the new one loads from the wrong folder.
  void vault.openPath
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
      return path === null ? null : fileUrl(path)
    },
  }
}
</script>

<div class="editor" bind:this={parent}></div>

<style>
.editor {
  height: 100%;
  min-height: 0;
}
</style>
