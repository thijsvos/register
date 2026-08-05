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
        entryFileNames: 'assets/shell-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        manualChunks: (id) =>
          id.includes('/src/editor/') ||
          id.includes('@codemirror') ||
          id.includes('@lezer')
            ? 'editor'
            : undefined,
      },
    },
  },
  server: {
    // The Rust binary owns /api; vite only serves the shell in dev.
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
