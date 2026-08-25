import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readTokenTotals } from '../src/client/index.tsx'
import { ZERO_USAGE } from '../src/shared/usage.ts'

const TOTALS = {
  uncachedInputTokens: 100_200,
  cacheReadTokens: 355_800,
  cacheWriteTokens: 120,
  outputTokens: 5_300,
}

test('reads the flat DSH tokenUsage projection wire view', () => {
  assert.deepEqual(readTokenTotals(TOTALS), TOTALS)
})

test('keeps compatibility with the token-meter internal state shape', () => {
  assert.deepEqual(readTokenTotals({ totals: TOTALS, last: null }), TOTALS)
})

test('invalid projection values fail closed to zero', () => {
  assert.deepEqual(readTokenTotals(undefined), ZERO_USAGE)
  assert.deepEqual(readTokenTotals({ uncachedInputTokens: Number.NaN }), ZERO_USAGE)
})
