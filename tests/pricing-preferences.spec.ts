import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mergePricingTable,
  readLocalPriceOverrides,
  withLocalPrice,
  writeLocalPriceOverrides,
  type KeyValueStorage,
} from '../src/client/pricing-preferences.ts'
import { LOCAL_PRICING_STORAGE_KEY, type PricingTable } from '../src/shared/usage.ts'

class MemoryKeyValueStorage implements KeyValueStorage {
  data = new Map<string, string>()
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void { this.data.set(key, value) }
}

const HOST: PricingTable = {
  default: { inputCacheHitPerMTokCNY: 0, inputCacheMissPerMTokCNY: 0, outputPerMTokCNY: 0 },
  overrides: { model: { inputCacheHitPerMTokCNY: 1, inputCacheMissPerMTokCNY: 2, outputPerMTokCNY: 3 } },
  peakHours: { weekdays: [], windows: [], timezone: 'Asia/Shanghai' },
}

test('local pricing round-trips and normalizes model ids', () => {
  const storage = new MemoryKeyValueStorage()
  const local = withLocalPrice({}, '  MiniMax-M3  ', {
    inputCacheHitPerMTokCNY: 0.2,
    inputCacheMissPerMTokCNY: 1.1,
    outputPerMTokCNY: 4.4,
  })
  writeLocalPriceOverrides(local, storage)
  assert.ok(storage.data.has(LOCAL_PRICING_STORAGE_KEY))
  assert.deepEqual(readLocalPriceOverrides(storage), local)
  assert.ok('minimax-m3' in local)
})

test('local pricing overrides Host values and can be removed', () => {
  const local = withLocalPrice({}, 'model', {
    inputCacheHitPerMTokCNY: 7,
    inputCacheMissPerMTokCNY: 8,
    outputPerMTokCNY: 9,
  })
  assert.equal(mergePricingTable(HOST, local).overrides.model.outputPerMTokCNY, 9)
  assert.deepEqual(withLocalPrice(local, 'MODEL', null), {})
})

test('corrupt and negative local price entries are ignored', () => {
  const storage = new MemoryKeyValueStorage()
  storage.setItem(LOCAL_PRICING_STORAGE_KEY, JSON.stringify({
    good: { inputCacheHitPerMTokCNY: 0, inputCacheMissPerMTokCNY: 1, outputPerMTokCNY: 2 },
    bad: { inputCacheHitPerMTokCNY: -1, inputCacheMissPerMTokCNY: 1, outputPerMTokCNY: 2 },
  }))
  assert.deepEqual(Object.keys(readLocalPriceOverrides(storage)), ['good'])
})
