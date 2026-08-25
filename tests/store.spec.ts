import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQuotaStore } from '../src/client/store.ts'
import type { QuotaApi } from '../src/client/api.ts'

function snapshot(providerId: string) {
  return {
    providerId,
    providerDisplayName: providerId,
    status: 'ok' as const,
    fetchedAt: '2026-08-19T00:00:00.000Z',
    capabilities: { balance: true, quota: false },
  }
}

const EMPTY_PRICING = {
  default: { inputCacheHitPerMTokCNY: 0, inputCacheMissPerMTokCNY: 0, outputPerMTokCNY: 0 },
  overrides: {},
  peakHours: { weekdays: [], windows: [], timezone: 'Asia/Shanghai' },
}

function makeApi(overrides?: (calls: string[]) => Partial<QuotaApi>): { api: QuotaApi; calls: string[] } {
  const calls: string[] = []
  const api: QuotaApi = {
    async listProviders() { return [] },
    async getCurrent() {
      calls.push('current')
      return { snapshot: snapshot('deepseek-official') }
    },
    async getProvider(id) {
      calls.push(`provider:${id}`)
      return { snapshot: snapshot(id) }
    },
    async refresh() {
      throw new Error('not used by the store')
    },
    async getSettings() {
      calls.push('settings')
      return { pricing: EMPTY_PRICING }
    },
    ...(overrides?.(calls) ?? {}),
  }
  return { api, calls }
}

test('manual provider selection fetches that billing provider instead of the current route', async () => {
  const { api, calls } = makeApi()
  const store = createQuotaStore(api)

  await store.actions.setManual('minimax-official')

  assert.equal(store.getSnapshot().mode, 'manual')
  assert.equal(store.getSnapshot().manualId, 'minimax-official')
  assert.equal(store.getSnapshot().snapshot?.providerId, 'minimax-official')
  assert.deepEqual(calls, ['provider:minimax-official'])
})

test('switching back to auto refreshes the host-resolved current route', async () => {
  const { api, calls } = makeApi()
  const store = createQuotaStore(api)

  await store.actions.setManual('minimax-official')
  await store.actions.setMode('auto')

  assert.equal(store.getSnapshot().mode, 'auto')
  assert.equal(store.getSnapshot().manualId, 'minimax-official')
  assert.equal(store.getSnapshot().snapshot?.providerId, 'deepseek-official')
  assert.deepEqual(calls, ['provider:minimax-official', 'current'])
})

test('applyUsage updates the token snapshot without touching the provider snapshot', async () => {
  const { api } = makeApi()
  const store = createQuotaStore(api)
  store.actions.applyUsage({
    tokens: { uncachedInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 30 },
    model: 'deepseek-v4-pro',
    today: { inCacheHit: 50, inCacheMiss: 100, cacheWrite: 10, out: 30, costCNY: 0.42, hasPricing: true },
    lifetime: { inCacheHit: 500, inCacheMiss: 1000, cacheWrite: 50, out: 300, costCNY: 4.2, hasPricing: true },
  })
  const snap = store.getSnapshot()
  assert.equal(snap.currentModel, 'deepseek-v4-pro')
  assert.equal(snap.currentTokens.cacheReadTokens, 50)
  assert.equal(snap.usageToday.costCNY, 0.42)
  assert.equal(snap.usageLifetime.inCacheMiss, 1000)
})

test('older Host settings responses keep safe client defaults', () => {
  const { api } = makeApi()
  const store = createQuotaStore(api)
  store.actions.applySettings({ pricing: EMPTY_PRICING } as never)
  const state = store.getSnapshot()
  assert.equal(state.refreshIntervalMs, 60_000)
  assert.equal(state.warningBalanceBelow, 10)
  assert.equal(state.warningQuotaRemainingBelow, 0.2)
})
