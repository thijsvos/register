<script lang="ts">
// Registration marks at the viewport corners — the product is named after them.
// Decorative, so --faint is the correct ink (§02 scopes it to "crosses, meters,
// rules") and they are hidden from assistive technology.
</script>

<span class="cross tl" aria-hidden="true">+</span>
<span class="cross tr" aria-hidden="true">+</span>
<span class="cross bl" aria-hidden="true">+</span>
<span class="cross br" aria-hidden="true">+</span>

<style>
.cross {
  position: fixed;
  z-index: 60;
  color: var(--faint);
  font-size: var(--text-micro);
  line-height: 1;
  pointer-events: none;
  user-select: none;
}
.tl { top: var(--cross-y); left: var(--cross-x); }
.tr { top: var(--cross-y); right: var(--cross-x); }
.bl { bottom: var(--cross-y); left: var(--cross-x); }
.br { bottom: var(--cross-y); right: var(--cross-x); }
</style>
