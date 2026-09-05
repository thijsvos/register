/// <reference types="vitest/config" />
import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

/**
 * The extract's bundle — the same app, as one file (§12, ADR-008).
 *
 * `vite.config.ts` splits the UI on purpose: a shell that paints first, a lazy
 * editor that arrives when a note opens, and a `core` chunk kept on the shell
 * side so §06's two JS budgets stay separately measurable. `register extract`
 * writes a vault and its reader into a single HTML file that opens from disk,
 * and a single file cannot dynamic-`import()` — there is nothing to fetch from.
 * So this build folds every chunk into one script and every stylesheet into one
 * sheet, under names the Rust side can address without a hash.
 *
 * A second config rather than a flag on the first, because the two disagree on
 * exactly the thing the first exists to enforce: `inlineDynamicImports` and
 * `manualChunks` cannot both be set, and the doctrine test that keeps the editor
 * lazy is about the served app, not this one.
 *
 * `publicDir` is off. The fonts and the boot script are already embedded in the
 * binary for the served app, and `src/extract.rs` reads them from there — a
 * second copy here would put 200 kB of the same bytes in the binary twice.
 */
export default defineConfig({
  plugins: [svelte()],
  publicDir: false,
  build: {
    outDir: 'dist/extract',
    emptyOutDir: true,
    cssCodeSplit: false,
    // Nothing to preload when there is nothing to fetch.
    modulePreload: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/main.ts'),
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'extract.js',
        assetFileNames: 'extract.[ext]',
      },
    },
  },
})
