/**
 * §02b nav row: "↑↓ / j–k traversal".
 *
 * Shared rather than repeated per pane, because the state matrix describes one
 * component. Three panes with three slightly different traversals is exactly the
 * drift §02b exists to stop.
 */
export function traverse(event: KeyboardEvent): void {
  const forward = event.key === 'ArrowDown' || event.key === 'j'
  const back = event.key === 'ArrowUp' || event.key === 'k'
  if (!forward && !back) return

  const row = event.currentTarget
  if (!(row instanceof HTMLElement)) return

  const sibling = forward ? row.nextElementSibling : row.previousElementSibling
  if (sibling instanceof HTMLElement) {
    event.preventDefault()
    sibling.focus()
  }
}
