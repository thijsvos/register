/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [svelte()],
  build: {
    rollupOptions: {
      output: {
        // Named chunks so §06's two JS budgets stay separately enforceable:
        // the shell at 60 kB gz and the lazy editor at 150 kB gz. Without the
        // manual grouping, CodeMirror would be spread across anonymous chunks
        // and neither budget could be measured.
        //
        // `core` is named for a second reason. The editor reads the vault's own
        // definitions — what a wikilink is, in P6 — so those modules are
        // reachable from both the entry and the lazy chunk. Left unassigned, the
        // bundler resolves that by putting them in the lazy chunk and making the
        // entry import it statically, which loads all of CodeMirror at boot and
        // measures as no change at all against a budget that only weighs
        // `shell-*.js`. Naming the chunk keeps the shared code on the shell side
        // of the boundary, where both can reach it without dragging the editor in.
        entryFileNames: 'assets/shell-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        manualChunks: (id) => {
          if (
            id.includes('/src/editor/') ||
            id.includes('@codemirror') ||
            id.includes('@lezer')
          ) {
            return 'editor'
          }
          return id.includes('/src/core/') || id.includes('/src/lib/')
            ? 'core'
            : undefined
        },
      },
    },
  },
  server: {
    // The Rust binary owns /api; vite only serves the shell in dev.
    //
    // The server has to be told to accept this origin, because it otherwise
    // accepts only the one it serves the app from:
    //
    //     register serve ~/vault --dev-origin http://localhost:5173
    //
    // It used to accept any loopback origin so this proxy would work without a
    // flag, which handed the same authority to every other web server on the
    // machine — a page on `http://localhost:3000`, in any tab, could read the
    // vault and write to it. `changeOrigin` rewrites Host, not Origin, so what
    // arrives is `Origin: http://localhost:5173` against `Host: localhost:7777`
    // and the two no longer match by design.
    proxy: {
      '/api': {
        target: 'http://localhost:7777',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    // Tests live under src/ so svelte-check type-checks them too.
    include: ['src/**/*.test.ts'],
    // Vitest stubs stylesheets out by default. doctrine.test.ts asserts against
    // the real CSS text, and a stubbed import would make it pass vacuously.
    css: true,
  },
})
