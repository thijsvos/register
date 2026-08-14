<script lang="ts">
import { vault } from '../core/store.svelte'
import { count, type Task, taskGroups } from '../core/tasks'
import { utcStamp } from '../lib/time'
import { go, traverse } from './nav'

// §02b Screen 5: "AGGREGATE · DERIVED FROM VAULT ... (stores nothing)". Every
// row here is a line in a file; nothing is written down anywhere else, which is
// why the pane can be rebuilt from the corpus on every keystroke.
let groups = $derived(taskGroups(vault.tree, vault.corpus))
let totals = $derived(count(groups))
let today = $derived(utcStamp().slice(0, 10))

// Open tasks only, per the frame — the totals line carries the rest. A group
// whose tasks are all done drops out with them rather than sitting empty.
let open = $derived(
  groups
    .map((group) => ({ entry: group.entry, tasks: group.tasks.filter((t) => !t.done) }))
    .filter((group) => group.tasks.length > 0),
)

function label(path: string, title: string | null): string {
  return title ?? path
}

function toggle(task: Task) {
  void vault.toggleTask(task.path, task.at)
}
</script>

<div class="today">
  <div class="head">
    <div class="stamp">
      <span>Aggregate · {today} · derived from vault</span>
      <!-- §01: "every control shows its key". Escape leaves any raised view. -->
      <span class="back">[Esc] back</span>
    </div>
    <div class="title">
      <h2>Today</h2>
      <span class="counts">{totals.open} open · {totals.total} total</span>
      <span class="aside">(stores nothing)</span>
    </div>
  </div>

  {#if open.length === 0}
    <p class="empty">
      {totals.total === 0
        ? 'No tasks in the vault. Write - [ ] in any note.'
        : 'Nothing open. Every task in the vault is done.'}
    </p>
  {:else}
    {#each open as group (group.entry.path)}
      <section>
        <h3 class="rule">
          <span class="ref">{group.entry.ref ?? '—'}</span>
          <span class="name">{label(group.entry.path, group.entry.title)}</span>
        </h3>
        <div class="rows">
          {#each group.tasks as task (task.at)}
            <div class="row">
              <!-- §02b Task: "[ ] fg · box cursor on hover · toggle by click or
                   ↵; writes to file". The box and the text are one control, so
                   the whole line is the target rather than three characters. -->
              <button
                class="task"
                role="checkbox"
                aria-checked="false"
                onclick={() => toggle(task)}
                onkeydown={traverse}
              >
                <span class="box" aria-hidden="true"></span>
                <span class="text">{task.text}</span>
              </button>
              <button
                class="goto"
                title="Open {label(group.entry.path, group.entry.title)}"
                onclick={() => go.note(task.path)}
              >
                → {group.entry.ref ?? label(group.entry.path, group.entry.title)}
              </button>
            </div>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
.today {
  max-width: var(--measure);
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
.back {
  flex: none;
  white-space: nowrap;
}
.title {
  display: flex;
  align-items: baseline;
  gap: var(--s3);
  padding: var(--s1) 0 var(--s4);
  border-bottom: var(--hairline) solid var(--line);
}
h2 {
  flex: none;
  font-size: var(--text-title);
  font-weight: 700;
  color: var(--hi);
}
.counts {
  flex: 1;
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  text-transform: uppercase;
  font-variant-numeric: tabular-nums;
}
.aside {
  flex: none;
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  text-transform: uppercase;
  color: var(--dim);
}

section {
  padding-top: var(--s4);
}
/* The frame draws a group header as a rule that runs to the edge. */
.rule {
  display: flex;
  align-items: center;
  gap: var(--s2);
  font-family: var(--font-micro);
  font-size: var(--text-micro);
  line-height: var(--lh-micro);
  font-weight: 400;
  letter-spacing: var(--track-micro);
  text-transform: uppercase;
  color: var(--dim);
  white-space: nowrap;
}
.rule::after {
  content: '';
  flex: 1;
  height: var(--hairline);
  background: var(--line);
}
.rule .name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.row {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
}
.task {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  flex: 1;
  min-width: 0;
  padding: var(--pane-y) 0;
  text-align: left;
  font-size: var(--text-body);
  line-height: var(--lh-body);
}
.task:hover {
  background: var(--hover);
  cursor: cell;
}
.task:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-inset);
}
/* Sized from the same token as the editor's own checkbox (--s4, see
   editor/theme.ts), so the same task is the same object in both places. */
.box {
  flex: none;
  width: var(--s4);
  height: var(--s4);
  border: var(--hairline) solid var(--line);
  align-self: center;
}
.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goto {
  flex: none;
  padding: var(--pane-y) 0;
  font-size: var(--text-ui);
  letter-spacing: var(--track-ui);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.goto:hover {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.goto:focus-visible {
  outline: var(--hairline) dashed var(--fg);
  outline-offset: var(--focus-offset);
}

.empty {
  padding: var(--s5) 0;
  font-size: var(--text-body);
  color: var(--dim);
}
</style>
