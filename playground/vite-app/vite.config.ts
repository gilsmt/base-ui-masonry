import path from 'node:path';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(() => {
  const isProfiling = process.env.REACT_PROFILING === '1' || process.env.REACT_PROFILING === 'true';
  const baseUrl = process.env.PLAYGROUND_BASE ?? '/';
  const outDir = process.env.PLAYGROUND_OUT_DIR ?? 'dist';
  const resolvedOutDir = path.isAbsolute(outDir) ? outDir : path.resolve(__dirname, outDir);

  return {
    base: baseUrl,
    plugins: [tailwindcss(), react()],
    build: {
      sourcemap: true,
      outDir: resolvedOutDir,
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        // Allow importing the vendored masonry directly from root src without publishing.
        // Usage: import { MasonryRoot } from '@/masonry'  -> resolves to ../../src/masonry.tsx
        //        import * as Masonry from '@masonry' is also supported for convenience.
        '@': path.resolve(__dirname, 'src'),
        '@masonry': path.resolve(__dirname, '../../src'),
        ...(isProfiling ? { 'react-dom/client': 'react-dom/profiling' } : {}),
      },
    },
    server: {
      fs: {
        // Allow serving the root masonry source when running playground inside repo.
        allow: [path.resolve(__dirname, '../..')],
      },
    },
  };
});
