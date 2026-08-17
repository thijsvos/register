<script lang="ts">
import { type Bucket, getTrash, purgeBucket, restoreBucket } from '../core/api'
import { basename } from '../core/paths'
import { vault } from '../core/store.svelte'
import { chrome } from './view.svelte'

/**
 * §02b Screen 9 — the trash.
 *
 * Deleting has never destroyed anything: `DELETE` renames the subtree into
 * `.register/trash/<stamp>/` **at its original vault path**, which is why a
 * restore is a move rather than archaeology. What was missing was any way to see
 * that from inside the app — the notice named a bucket, and getting something
 * back meant a `mv` in Finder at the moment you were least inclined to read
 * carefully.
 *
 * Read on demand rather than held in the store: the trash is not vault state the
 * frame draws, it is a screen you visit. Nothing else in the app needs it, and
 * fetching it at boot would put a directory walk in the start-up path §06
 * budgets at 500 ms.
 */
let buckets = $state<Bucket[]>([])
let loaded = $state(false)
/** The bucket a purge is armed against — never a click away from destroying. */
let arming = $state<string | null>(null)

async function load(): Promise<void> {
  try {
    buckets = await getTrash()
  } catch (error) {
    vault.notice = error instanceof Error ? error.message : String(error)
  }
  loaded = true
}

$effect(() => {
  void load()
})

async function restore(bucket: Bucket): Promise<void> {
  try {
    const put = await restoreBucket(bucket.name)
    // The server's counts, not the ones drawn: they differ by exactly what was
    // in the way, which is the half the screen could not know.
    vault.notice =
      put.kept === 0
        ? `Restored ${count(put.restored, 'file')}.`
        : `Restored ${count(put.restored, 'file')}; ${put.kept} left in the trash — something already lives there.`
  } catch (error) {
    vault.notice = error instanceof Error ? error.message : String(error)
    return
  }
  await Promise.all([load(), vault.refresh()])
}

async function purge(bucket: Bucket): Promise<void> {
  try {
    await purgeBucket(bucket.name)
    vault.notice = `Purged ${bucket.name}. That one is gone.`
  } catch (error) {
    vault.notice = error instanceof Error ? error.message : String(error)
    return
  }
  arming = null
  await Promise.all([load(), vault.refresh()])
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** `20260817T104233000Z` → `17 AUG 10:42`, which is what a person reads. */
function when(name: string): string {
  const parsed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(name)
  if (parsed === null) return name
  const [, year, month, day, hour, minute] = parsed
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)),
  )
  return date
    .toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
    .toUpperCase()
}

/** What the bucket held, named the way the INDEX would have named it. */
function held(bucket: Bucket): string {
  const first = bucket.paths[0]
  if (first === undefined) return '—'
  if (bucket.paths.length === 1) return first
  // The common folder if there is one, because a folder deletion is one act and
  // listing its files back would be a list of a list.
  const folder = first.slice(0, first.lastIndexOf('/'))
  return bucket.paths.every((path) => path.startsWith(`${folder}/`))
    ? `${folder}/`
    : `${basename(first)} +${bucket.paths.length - 1}`
}
</script>

<div class="trash">
  <div class="head">
    <div class="stamp">
      <span>Trash · nothing here was destroyed</span>
      <!-- §01: "every control shows its key". Escape leaves any raised view. -->
      <button class="back" onclick={() => chrome.showNotes()}>[Esc] back</button>
    </div>
    <div class="title">
      <h2>Trash</h2>
      <span class="meta">{buckets.length === 0 ? '' : count(buckets.length, 'deletion')}</span>
    </div>
  </div>

  {#if !loaded}
    <p class="empty">Reading.</p>
  {:else if buckets.length === 0}
    <!-- §02b Screen 3's voice: what is true, then what to do about it. -->
    <p class="empty">Nothing deleted. ⌫ on an index row is what puts something here.</p>
  {:else}
    <ul class="rows">
      {#each buckets as bucket (bucket.name)}
        <li class:armed={arming === bucket.name}>
          <span class="stampcol">{when(bucket.name)}</span>
          <span class="what">
            {held(bucket)}
            <span class="counts">
              {count(bucket.notes, 'note')}{bucket.files === 0
                ? ''
                : ` · ${count(bucket.files, 'file')}`}
            </span>
          </span>
          {#if arming === bucket.name}
            <span class="answers">
              <!-- Armed rather than confirmed in a modal: §02b's answer to a
                   destructive question is the palette's two answers, and this is
                   the same shape without a second focus model to get wrong. -->
              <button class="answer" onclick={() => purge(bucket)}>Purge for good</button>
              <button class="answer" onclick={() => (arming = null)}>Keep</button>
            </span>
          {:else}
            <span class="answers">
              <button
                class="act"
                disabled={!bucket.clear && bucket.paths.length === 0}
                onclick={() => restore(bucket)}>[↵] restore</button
              >
              <button class="act" onclick={() => (arming = bucket.name)}>[⌦] purge</button>
            </span>
          {/if}
          {#if !bucket.clear}
            <!-- Said rather than prevented: the restore still runs and skips
                 what is occupied, because refusing the whole bucket over one
                 path would be the app deciding for you. -->
            <span class="note">Something already lives at one of these paths.</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
.trash {
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
   so a <button> inherits neither from the row it sits in — see Today.svelte,
   where deleting these two lines as redundant cost the label its casing. */
.back {
  flex: none;
  white-space: nowrap;
  text-transform: uppercase;
  letter-spacing: var(--track-micro);
}
.back:hover,
.act:hover,
.answer:hover {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.back:focus-visible,
.act:focus-visible,
.answer:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
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
  color: var(--dim);
}

.rows {
  list-style: none;
}
.rows li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--s3);
  padding: var(--s3) 0;
  border-bottom: var(--hairline) solid var(--line);
}
.stampcol {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.what {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.counts,
.note {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}
.note {
  grid-column: 2 / -1;
}
.answers {
  display: flex;
  gap: var(--s3);
  white-space: nowrap;
}
.act,
.answer {
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
}
/* Armed: the row says so in ink rather than in colour, because §02 keeps the
   accent for the live edge and a question is not one. */
.rows li.armed .what,
.answer {
  color: var(--hi);
}
</style>
