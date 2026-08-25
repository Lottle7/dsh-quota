import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/build-client.mjs', import.meta.url))
const clientEntry = fileURLToPath(new URL('../src/client/index.tsx', import.meta.url))

test('client entry declares every Cordis service it reads', () => {
  const source = readFileSync(clientEntry, 'utf8')
  assert.match(source, /export const inject = \["slots", "sessions", "modelDirectories"\] as const/)
  assert.doesNotMatch(source, /\bsessions\?:/)
})

test('client wrapper converts aliased ESM imports into valid CommonJS destructuring', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-quota-client-'))
  const file = join(directory, 'client.js')
  try {
    writeFileSync(file, [
      'import { jsx as jsxFactory, jsxs as jsxsFactory } from "react/jsx-runtime";',
      'import { useEffect } from "react";',
      'export const name = "dsh-quota";',
      'export const inject = ["slots", "sessions"];',
      'export function apply() { return [jsxFactory, jsxsFactory, useEffect] }',
    ].join('\n'))
    execFileSync(process.execPath, [script, file], { stdio: 'pipe' })
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    const wrapped = readFileSync(file, 'utf8')
    assert.match(wrapped, /const \{ jsx: jsxFactory, jsxs: jsxsFactory \} = require\("react\/jsx-runtime"\)/)
    assert.doesNotMatch(wrapped, /\{ jsx as jsxFactory/)
    assert.match(wrapped, /const inject = \["slots", "sessions"\]/)
    assert.match(wrapped, /module\.exports\.inject = typeof inject/)
    assert.match(wrapped, /data-plugin-css=\\"dsh-quota\/styles\.css\\"/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
