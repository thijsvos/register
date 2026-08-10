<script lang="ts">
import { fileUrl } from '../core/api'
import { basename } from '../core/paths'

let { path }: { path: string } = $props()

let url = $derived(fileUrl(path))
let name = $derived(basename(path))

/**
 * A PDF is framed; anything else is an image.
 *
 * Decided from the extension here and only here — the *server* decides what a
 * file really is, from its magic number, and refuses anything it does not
 * recognise. So the worst this guess can do is pick the wrong container for a
 * file that was going to be refused anyway.
 */
let isPdf = $derived(/\.pdf$/i.test(path))

/** Set when the browser gives up on the bytes, which is the only way to know. */
let failed = $state(false)
// Reset when the file changes, or one bad file would poison every later one.
$effect(() => {
  void path
  failed = false
})
</script>

<div class="media">
  <div class="stamp">{isPdf ? 'Document' : 'Image'} · {path}</div>

  {#if failed}
    <p class="gone">Not in the vault, or not a format this app will show.</p>
  {:else if isPdf}
    <!--
      The browser's own viewer, which costs nothing to ship. `object-src 'none'`
      rules out <embed>, and pdf.js measures ~350 kB gz against §06's 150 kB
      editor budget. The server sends `frame-ancestors 'self'` on this one route
      so that this frame is permitted and no other page's is.
    -->
    <iframe class="frame" src={url} title={name}></iframe>
  {:else}
    <img class="shown" src={url} alt={name} onerror={() => (failed = true)} />
  {/if}
</div>

<style>
.media {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  padding: var(--s5);
  gap: var(--s4);
}

/* The same micro-label the settings pane stamps itself with. */
.stamp {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
  padding-bottom: var(--s3);
  border-bottom: var(--hairline) solid var(--line);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A document gets the room; §02's measure caps prose, and this is not prose. */
.frame {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: var(--hairline) solid var(--line);
  background: var(--bg);
}

.shown {
  /* Contained rather than cropped or stretched: an image opened full-pane is
     being looked at, and the one thing that must not happen is a lie about its
     proportions. */
  min-height: 0;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  align-self: flex-start;
  border: var(--hairline) solid var(--line);
}

.gone {
  font-size: var(--text-body);
  color: var(--dim);
}
</style>
