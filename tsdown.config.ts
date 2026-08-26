import { defineConfig } from 'tsdown/config'

const shared = {
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  target: 'es2022',
  platform: 'neutral',
  treeshake: true,
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/schemastery',
      'zod',
      'node:dns/promises',
      'node:https',
      'node:net',
    ],
  },
} as const

export default defineConfig([
  {
    ...shared,
    entry: { index: './src/host/index.ts' },
    clean: true,
  },
  {
    ...shared,
    entry: { client: './src/client/index.tsx' },
    clean: false,
    // DSH loads exactly one browser factory per plugin. A shared chunk would
    // become a relative require() which its module table cannot serve.
    outputOptions: {
      codeSplitting: false,
    },
  },
])
