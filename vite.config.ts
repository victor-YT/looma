import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({

  base: './',

  plugins: [
    tailwindcss(),
    react(),
    electron({
      main: {
        entry: {
          main: 'electron/main.ts',
          strategyWorker: 'electron/workers/strategy/strategyWorker.ts',
          strategyDevWorker: 'electron/workers/strategy/devSandboxWorker.ts',
          'strategies/builtin/minimal': 'electron/strategies/builtin/minimal.ts',
          'strategies/builtin/memory-first': 'electron/strategies/builtin/memory-first.ts',
          memorySmoke: 'electron/memorySmokeRunner.ts',
          modelSmoke: 'electron/modelSmokeRunner.ts',
          strategySwitchSmoke: 'electron/strategySwitchSmokeRunner.ts',
          strategyMemoryCloudSmoke: 'electron/strategyMemoryCloudSmokeRunner.ts',
          strategyMemorySmoke: 'electron/strategyMemorySmokeRunner.ts',
        },
        vite: {
          build: {
            commonjsOptions: {
              ignoreDynamicRequires: false,
              dynamicRequireTargets: [
                'node_modules/pdfjs-dist/legacy/build/pdf.js',
                'node_modules/pdfjs-dist/build/pdf.js',
                'node_modules/pdfjs-dist/**',
                'node_modules/pdf-parse/lib/pdf.js/**',
              ],
            },
            rollupOptions: {
              external: ['esbuild'],
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      renderer: process.env.NODE_ENV === 'test'
        ? undefined
        : {},
    }),
    // copy config
    viteStaticCopy({
      targets: [
        {
          src: 'electron/config',
          dest: '.'              // aim path，copy to dist-electron/config
        }
      ]
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@contracts': path.resolve(__dirname, './contracts'),
      '@shared': path.resolve(__dirname, './shared')
    },
  },
})
