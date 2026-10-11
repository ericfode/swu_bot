import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The viewer kit: src/kit/index.tsx as a self-contained library (React, styles and all), for embedding in other pages.
//   npm run build:kit  ->  dist-kit/swu-viewer-kit.js (IIFE, global SWUViewer) and dist-kit/swu-viewer-kit.mjs (ES module)
export default defineConfig({
    plugins: [react(), tailwindcss()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
        outDir: 'dist-kit',
        lib: {
            entry: 'src/kit/index.tsx',
            name: 'SWUViewer',
            formats: ['iife', 'es'],
            fileName: (f) => (f === 'iife' ? 'swu-viewer-kit.js' : 'swu-viewer-kit.mjs')
        },
        chunkSizeWarningLimit: 4000
    }
});
