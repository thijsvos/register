<script lang="ts">
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
    editor.load(text)
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

// An OUTLINE row asking to be scrolled to. Tracked by nonce rather than
// consumed, because clearing state from inside the effect that reads it costs a
// second pass — and a stale request must not re-fire when the editor is rebuilt
// for a different note.
let revealed = 0
$effect(() => {
  const target = chrome.revealAt
  const editor = handle
  if (target === null || editor === null || target.nonce === revealed) return
  revealed = target.nonce
  editor.reveal(target.position)
})

// The vault index changes under a still document — an agent can create the note
// a dotted wikilink points at — so the callbacks are swapped rather than baked
// in, and the decorations rebuild when they change.
$effect(() => {
  void vault.tree
  handle?.setHost(wikiHost())
})

function wikiHost() {
  return {
    exists: (target: string) => vault.resolve(target) !== null,
    open: (target: string) => go.follow(target),
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
