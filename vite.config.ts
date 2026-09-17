import { defineConfig } from 'vite';

// Yandex.Games serves the build from a nested path, so all asset URLs must be relative.
export default defineConfig({
  base: './',
  build: {
    target: 'es2019',
    minify: 'terser',
    // Each page ships only its own stylesheet.
    cssCodeSplit: true,
    assetsInlineLimit: 8192,
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      format: { comments: false },
    },
    rollupOptions: {
      // Two games live in this repo: the 3D racer at the root and the merge
      // game under /merge. Each builds into its own page.
      input: {
        main: 'index.html',
        merge: 'merge/index.html',
      },
      output: {
        // Single chunk keeps the first paint fast, which Yandex ranks on.
        manualChunks: undefined,
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
  server: { host: true, port: 5173 },
});
