<script lang="ts">
// Sentence-case messages, so they take the §02 body role (13px, no tracking) —
// not the 11px UI role, which is uppercase and scoped to nav, buttons, key
// hints and table headers. Shared by both panes so they cannot drift apart.
let { text }: { text: string } = $props()
</script>

<p class="empty">{text}</p>

<style>
.empty {
  padding: var(--pane-y) var(--pane-x) var(--s2);
  border-bottom: var(--hairline) solid var(--line);
  font-size: var(--text-body);
  color: var(--dim);
}
</style>
