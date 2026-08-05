<script lang="ts">
import { vault } from '../core/store.svelte'

// A plain textarea is the interim editing surface. P4 replaces it with
// CodeMirror 6 as a lazy chunk; until then this is enough to exercise the save
// pipeline, and markdown stays the literal source either way.
let element: HTMLTextAreaElement | null = $state(null)

// An IME — Chinese, Japanese, Korean, and macOS accent entry — fires `input`
// for every intermediate candidate. Treating those as edits would write
// half-formed words to disk, and rewriting the textarea mid-composition
// cancels the composition outright.
let composing = $state(false)

// The store rewrites the buffer twice behind the user's back: on save, to stamp
// `modified`, and on an external change to a clean note. Assigning through
// `value` would drop the caret to the end each time, so it is restored here.
$effect(() => {
  const text = vault.buffer
  if (element === null || composing || element.value === text) return

  const { selectionStart, selectionEnd } = element
  element.value = text
  element.setSelectionRange(
    Math.min(selectionStart, text.length),
    Math.min(selectionEnd, text.length),
  )
})
</script>

<textarea
  bind:this={element}
  aria-label={vault.active?.title ?? 'Note'}
  spellcheck="false"
  autocomplete="off"
  autocapitalize="off"
  oncompositionstart={() => {
    composing = true
  }}
  oncompositionend={(event) => {
    composing = false
    vault.edit(event.currentTarget.value)
  }}
  oninput={(event) => {
    if (!composing) vault.edit(event.currentTarget.value)
  }}
></textarea>

<style>
textarea {
  display: block;
  width: 100%;
  max-width: var(--measure);
  min-height: 100%;
  margin: 0 auto;
  padding: var(--s6) var(--s5);
  border: none;
  outline: none;
  resize: none;
  background: none;
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--text-body);
  line-height: var(--lh-body);
  /* §02b Input: "signal caret, no box" — the frame is the label. */
  caret-color: var(--signal);
}
</style>
