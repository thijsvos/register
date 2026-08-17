<script lang="ts">
import type { BodyFace, Scale, Scheme } from '../core/settings.svelte'
import { settings } from '../core/settings.svelte'
import { vault } from '../core/store.svelte'
import { chrome } from './view.svelte'

let picker: HTMLInputElement | null = $state(null)

// §02b Screen 6 draws two buttons and no third. Pressing the lit one returns to
// following the OS, which is the only way back to the default once you have
// pinned — a setting you cannot unset is a one-way door.
function chooseScheme(wanted: Scheme) {
  void settings.setScheme(settings.scheme === wanted ? 'system' : wanted)
}

function chooseFace(wanted: BodyFace) {
  void settings.setBodyFace(wanted)
}

// Unlike SCHEME, pressing the lit key does not toggle back: `auto` is a button
// of its own here, so there is already a way back and making the pins toggle
// would give two.
function chooseScale(wanted: Scale) {
  void settings.setScale(wanted)
}

function pick(event: Event) {
  const chosen = (event.currentTarget as HTMLInputElement).files?.[0]
  if (chosen !== undefined) void settings.useFont(chosen)
  // Cleared so picking the same file twice fires twice — reloading a font you
  // just replaced on disk is a reasonable thing to want.
  if (picker !== null) picker.value = ''
}
</script>

<div class="settings">
  <div class="stamp">
    <span>Config · .register/config.json</span>
    <!-- §01: "every control shows its key". Escape leaves any raised view. -->
    <button class="back" onclick={() => chrome.showNotes()}>[Esc] back</button>
  </div>

  <div class="row">
    <div class="key">Scheme</div>
    <div class="controls">
      <button class="opt" aria-pressed={settings.scheme === 'light'}
        onclick={() => chooseScheme('light')}>Light</button>
      <button class="opt" aria-pressed={settings.scheme === 'dark'}
        onclick={() => chooseScheme('dark')}>Dark</button>
      <span class="note">
        {settings.scheme === 'system' ? 'Following the OS' : 'Press again to follow the OS'}
      </span>
    </div>
  </div>

  <div class="row">
    <div class="key">Body face</div>
    <div class="controls">
      <button class="opt" aria-pressed={settings.bodyFace === 'default'}
        onclick={() => chooseFace('default')}>Default · Commit</button>
      <button class="opt" aria-pressed={settings.bodyFace === 'teletype'}
        onclick={() => chooseFace('teletype')}>Teletype · Server</button>
    </div>
  </div>

  <div class="row">
    <div class="key">Scale</div>
    <div class="controls">
      <button class="opt" aria-pressed={settings.scale === 'auto'}
        onclick={() => chooseScale('auto')}>Auto</button>
      <button class="opt" aria-pressed={settings.scale === 1}
        onclick={() => chooseScale(1)}>1×</button>
      <button class="opt" aria-pressed={settings.scale === 2}
        onclick={() => chooseScale(2)}>2×</button>
      <!-- The thresholds themselves stay in tokens.css and are deliberately not
           restated here: copy that repeats a constant is copy that lies the day
           the constant moves. -->
      <span class="note">
        {settings.scale === 'auto'
          ? 'Follows the canvas — 2× where there is room'
          : settings.scale === 1
            ? 'Pinned — never scales'
            : '2× wherever the frame fits'}
      </span>
    </div>
  </div>

  <div class="row">
    <div class="key">Licensed font</div>
    <!-- §02: "Emphasis is a double rule (border + offset outline)." -->
    <div class="byof">
      <div class="byof-head">Load Berkeley Mono / TX-02 from disk</div>
      <div class="byof-body">
        <label class="opt file">
          Choose .woff2 / .ttf / .otf
          <input
            bind:this={picker}
            type="file"
            accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
            onchange={pick}
          />
        </label>

        {#if settings.font === 'loaded'}
          <span class="state"
            ><span aria-hidden="true">◉</span> Loaded — registered as TX-02, restyled</span
          >
          <button class="opt" onclick={() => settings.clearFont()}>Remove</button>
        {:else if settings.font === 'loading'}
          <span class="state">Reading…</span>
        {:else if settings.font === 'error'}
          <span class="state alert">{settings.notice ?? 'Could not read that file.'}</span>
        {:else}
          <span class="state">No licensed font loaded.</span>
        {/if}
      </div>
    </div>
  </div>

  <p class="legal">
    Berkeley Mono is commercial: BYOF only, bytes never leave the machine, never
    committed (§03). Yours is stored in
    <code>{vault.vaultPath ?? 'the vault'}/.register/fonts/</code>, which
    <code>register init --git</code> puts in .gitignore.
  </p>
</div>

<style>
.settings {
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
  padding-bottom: var(--s4);
  border-bottom: var(--hairline) solid var(--line);
}
/* Text that is a control, the way the status bar's `N unresolved` already is:
   no box on a micro-type stamp line, but §02b's hover-inverse and dashed focus
   ring both hold. It says the key and answers the click, so the two ways out
   are one control rather than a hint beside an invisible one. */
.back {
  flex: none;
  white-space: nowrap;
  /* Not duplication of the stamp's own casing and tracking, however much it
     reads like it. A browser's UA stylesheet resets `text-transform` and
     `letter-spacing` on form controls, so a <button> inherits neither from the
     row it sits in — `base.css`'s `font: inherit` covers the family, the size
     and the weight, and stops there. Both lines were deleted once as redundant
     and the label came back sentence-case and untracked, which is how the
     status bar's own text-control learned to declare them too. */
  text-transform: uppercase;
  letter-spacing: var(--track-micro);
}
.back:hover {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.back:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
}

.row {
  display: grid;
  grid-template-columns: var(--set-key) minmax(0, 1fr);
  gap: var(--s3);
  align-items: start;
  padding: var(--s4) 0;
  border-bottom: var(--hairline) solid var(--line);
}
.key {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
}

/* §02b state matrix, Button / key: 1px box · hover inverse · aria-pressed
   inverse · dashed focus ring offset 2px. */
.opt {
  border: var(--hairline) solid var(--line);
  padding: var(--key-pad-y) var(--s3);
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  text-transform: uppercase;
  white-space: nowrap;
  cursor: pointer;
}
.opt:hover,
.opt[aria-pressed='true'] {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.opt:focus-visible,
.file:focus-within {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
}
/* The label is the control; the input itself is never drawn. */
.file input {
  position: absolute;
  width: var(--hairline);
  height: var(--hairline);
  opacity: 0;
  pointer-events: none;
}

.note,
.state {
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  color: var(--dim);
}
.alert {
  color: var(--signal);
}

.byof {
  border: var(--hairline) solid var(--line);
  outline: var(--hairline) solid var(--line);
  outline-offset: var(--rule-offset);
}
.byof-head {
  padding: var(--pane-y) var(--s3);
  border-bottom: var(--hairline) solid var(--line);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
}
.byof-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
  padding: var(--s3);
}

.legal {
  padding-top: var(--s4);
  font-size: var(--text-ui);
  line-height: var(--lh-body);
  color: var(--dim);
}
code {
  font-family: var(--font-ui);
  color: var(--fg);
}
</style>
