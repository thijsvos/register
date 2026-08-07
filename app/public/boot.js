/* Boot into the OS scheme before first paint — no flash, no stored state.
 *
 * A file rather than an inline <script> because the server sends a Content
 * Security Policy, and `default-src 'self'` blocks inline execution. The
 * alternatives were a sha256 hash in the policy, which is two places to keep in
 * step and silently stops matching the moment anyone edits this, or
 * `'unsafe-inline'`, which is the thing the policy exists to forbid. A same
 * origin file costs one small request and cannot drift.
 *
 * Loaded synchronously in <head>, so it still runs before the first paint.
 * `app/public/` is copied verbatim by Vite, so the path carries no content hash
 * and the tag in index.html stays correct.
 */
if (matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('dark')
}
