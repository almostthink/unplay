import { defineConfig } from 'vite';

// Yandex.Games serves the build from a nested path, so all asset URLs must be relative.
export default defineConfig({
  base: './',
  build: {
    target: 'es2019',
    minify: 'terser',
    cssCodeSplit: false,
    assetsInlineLimit: 8192,
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      format: { comments: false },
    },
    rollupOptions: {
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
