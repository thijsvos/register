/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [svelte()],
  build: {
    rollupOptions: {
      // Name the entry chunk so size-limit can hold the §06 shell budget on its
      // own. Lazy chunks land beside it under their own names and get their own
      // budget entries in the phase that introduces them.
      output: { entryFileNames: 'assets/shell-[hash].js' },
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
  },
})
