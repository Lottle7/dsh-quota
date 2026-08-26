import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UsageStore,
  aggregateBreakdown,
  aggregateDaily,
  aggregateLifetime,
  aggregateToday,
  localDateString,
  type UsageStorage,
} from '../src/client/usage-store.ts'
import {
  ZERO_USAGE,
  addUsage,
  diffUsage,
  type PricingTable,
} from '../src/shared/usage.ts'

class MemoryStorage implements UsageStorage {
  data: string | null = null
  read(): string | null { return this.data }
  write(v: string): void { this.data = v }
}

const OFF_PEAK = {
  default: { inputCacheHitPerMTokCNY: 0.05, inputCacheMissPerMTokCNY: 1.5, outputPerMTokCNY: 4.5 },
  overrides: {},
  peakHours: { weekdays: [], windows: [], timezone: 'Asia/Shanghai' },
}

function nowReturning(t: number): () => number { return () => t }

test('localDateString uses local YYYY-MM-DD', () => {
  // Use the same instant we use elsewhere; depends on the host timezone.
  // Just verify the format is YYYY-MM-DD.
  const s = localDateString(Date.now())
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/)
})

test('UsageStore starts empty when localStorage is empty', () => {
  const store = new UsageStore({
    storage: new MemoryStorage(),
    reconcileIntervalMs: 0,
  })
  assert.deepEqual(store.getState(), { days: [], baselines: {} })
  store.dispose()
})

test('observeTokenUsage appends the delta to today\'s per-model bucket', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const store = new UsageStore({
    storage,
    now: nowReturning(t),
    pricing: OFF_PEAK,
    reconcileIntervalMs: 0,
  })
  store.observeTokenUsage(
    { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  store.observeTokenUsage(
    { uncachedInputTokens: 1_500_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500_000 },
    'deepseek-v4-flash',
  )
  // After dispose() forces a flush, localStorage should hold the day.
  store.dispose()
  const parsed = JSON.parse(storage.data!) as { days: { date: string; byModel: Record<string, unknown> }[] }
  assert.equal(parsed.days.length, 1)
  const day = parsed.days[0]
  assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/)
  const bucket = day.byModel['deepseek-v4-flash'] as { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; costCNY: number }
  // Cumulative: first obs added 1M, second obs added 500k delta = 1.5M total.
  assert.equal(bucket.uncachedInputTokens, 1_500_000)
  assert.equal(bucket.outputTokens, 500_000)
  assert.ok(bucket.costCNY > 0, 'cost should be computed and positive')
})

test('observeTokenUsage is idempotent: passing the same totals twice doesn\'t double-count', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const store = new UsageStore({ storage, now: nowReturning(t), pricing: OFF_PEAK, reconcileIntervalMs: 0 })
  store.observeTokenUsage(
    { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  store.observeTokenUsage(
    { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  store.dispose()
  const parsed = JSON.parse(storage.data!) as { days: { byModel: Record<string, { uncachedInputTokens: number }> }[] }
  const bucket = parsed.days[0].byModel['deepseek-v4-flash']
  assert.equal(bucket.uncachedInputTokens, 1000, 'second observation of same totals should not double-count')
})

test('persisted session baseline prevents replay double-counting after reload', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const first = new UsageStore({ storage, now: nowReturning(t), pricing: OFF_PEAK, reconcileIntervalMs: 0 })
  first.observeTokenUsage(
    { uncachedInputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 300 },
    'deepseek-chat',
    'session-1',
    'deepseek',
  )
  first.dispose()

  const reloaded = new UsageStore({ storage, now: nowReturning(t), pricing: OFF_PEAK, reconcileIntervalMs: 0 })
  reloaded.observeTokenUsage(
    { uncachedInputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 300 },
    'deepseek-chat',
    'session-1',
    'deepseek',
  )
  reloaded.dispose()

  const parsed = JSON.parse(storage.data!) as { days: { byModel: Record<string, { uncachedInputTokens: number; outputTokens: number }> }[] }
  const bucket = parsed.days[0].byModel['deepseek::deepseek-chat']
  assert.equal(bucket.uncachedInputTokens, 1000)
  assert.equal(bucket.outputTokens, 300)
})

test('observeTokenUsage keeps the session baseline when the model changes', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const store = new UsageStore({ storage, now: nowReturning(t), pricing: OFF_PEAK, reconcileIntervalMs: 0 })
  store.observeTokenUsage(
    { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  // tokenUsage is cumulative for the Session. A model switch must keep the
  // same baseline or the previous 1000 tokens would be counted twice.
  store.observeTokenUsage(
    { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-pro',
  )
  store.observeTokenUsage(
    { uncachedInputTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-pro',
  )
  store.dispose()
  const parsed = JSON.parse(storage.data!) as { days: { byModel: Record<string, { uncachedInputTokens: number }> }[] }
  const proBucket = parsed.days[0].byModel['deepseek-v4-pro']
  const flashBucket = parsed.days[0].byModel['deepseek-v4-flash']
  assert.equal(proBucket.uncachedInputTokens, 500, 'only the post-switch delta belongs to pro')
  assert.equal(flashBucket.uncachedInputTokens, 1000)
})

test('day rollover: observations on different local dates land in different buckets', () => {
  const storage = new MemoryStorage()
  let t = Date.UTC(2026, 0, 22, 10, 0, 0) // Wed 10:00 UTC
  const store = new UsageStore({
    storage,
    now: () => t,
    pricing: OFF_PEAK,
    reconcileIntervalMs: 0,
  })
  // Day 1: first observation logs 100 uncached tokens (delta = 100 from 0).
  store.observeTokenUsage(
    { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  // Jump forward 25h so local date advances.
  t += 25 * 60 * 60 * 1000
  // Day 2: store observed 300 absolute (delta = 200 from day-1's lastTotals).
  store.observeTokenUsage(
    { uncachedInputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  store.dispose()
  const parsed = JSON.parse(storage.data!) as { days: { date: string; byModel: Record<string, { uncachedInputTokens: number }> }[] }
  assert.ok(parsed.days.length >= 2, 'expected two day buckets, got ' + parsed.days.length)
  const total = parsed.days.reduce((acc, d) => acc + d.byModel['deepseek-v4-flash'].uncachedInputTokens, 0)
  // Day 1: +100. Day 2: +200 (300 - lastTotals 100). Total 300.
  assert.equal(total, 300)
})

test('history trim keeps at most USAGE_HISTORY_DAYS days', () => {
  const storage = new MemoryStorage()
  // Seed storage with 50 days of zero buckets to force trim.
  const seeded = { days: [] as { date: string; byModel: Record<string, unknown> }[] }
  for (let i = 0; i < 50; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i))
    const iso = d.toISOString().slice(0, 10)
    seeded.days.push({ date: iso, byModel: {} })
  }
  storage.data = JSON.stringify(seeded)
  const t = Date.UTC(2026, 1, 10, 10, 0, 0)
  const store = new UsageStore({
    storage,
    now: nowReturning(t),
    pricing: OFF_PEAK,
    reconcileIntervalMs: 0,
  })
  // Trigger any flush path; dispose flushes synchronously.
  store.dispose()
  const parsed = JSON.parse(storage.data!) as { days: { date: string }[] }
  assert.ok(parsed.days.length <= 30, `expected ≤30 after trim, got ${parsed.days.length}`)
})

test('setPricing triggers a reconcile that recomputes cost', () => {
  const storage = new MemoryStorage()
  // 2026-01-22 (Thu) 10:00 Beijing = Thu 02:00 UTC — inside the morning
  // peak window. Peak pricing is in effect at this instant.
  const t = Date.UTC(2026, 0, 22, 2, 0, 0)
  // The peak config keeps the SAME numbers as the default, so the only
  // thing that changes between peak and off-peak is the windows
  // configuration (peak windows vs none). Half-rate is applied off-peak.
  const peakNumbers = { inputCacheHitPerMTokCNY: 0.10, inputCacheMissPerMTokCNY: 3.0, outputPerMTokCNY: 9.0 }
  const offPeakNumbers = { inputCacheHitPerMTokCNY: 0.05, inputCacheMissPerMTokCNY: 1.5, outputPerMTokCNY: 4.5 }
  const peak: PricingTable = {
    default: peakNumbers,
    overrides: {},
    peakHours: { weekdays: ['thu'], windows: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai' },
  }
  const offpeak: PricingTable = {
    default: peakNumbers,
    overrides: {},
    peakHours: { weekdays: ['thu'], windows: [{ start: '23:00', end: '23:30' }], timezone: 'Asia/Shanghai' },
  }
  const store = new UsageStore({
    storage,
    now: nowReturning(t),
    pricing: peak,
    reconcileIntervalMs: 0,
  })
  store.observeTokenUsage(
    { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  // Capture cost at peak
  const stateAtPeak = store.getState()
  const peakCost = stateAtPeak.days[0]?.byModel['deepseek-v4-flash']?.costCNY ?? 0
  assert.equal(peakCost, 3.0, 'expected peak cost = 3.0 (1M * 3.0 / 1M)')
  // Switch to off-peak and reconcile.
  store.setPricing(offpeak)
  const stateAtOff = store.getState()
  const offCost = stateAtOff.days[0]?.byModel['deepseek-v4-flash']?.costCNY ?? 0
  assert.equal(offCost, 1.5, 'expected off-peak cost = 1.5 (1M * 1.5 / 1M)')
  store.dispose()
})

test('aggregateToday returns the current day bucket', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const store = new UsageStore({
    storage,
    now: nowReturning(t),
    pricing: OFF_PEAK,
    reconcileIntervalMs: 0,
  })
  store.observeTokenUsage(
    { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 },
    'deepseek-v4-flash',
  )
  const agg = aggregateToday(store.getState(), OFF_PEAK, nowReturning(t))
  assert.equal(agg.inCacheMiss, 1000)
  assert.equal(agg.out, 500)
  assert.ok(agg.hasPricing)
  store.dispose()
})

test('aggregateLifetime sums every persisted day', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const store = new UsageStore({
    storage,
    now: nowReturning(t),
    pricing: OFF_PEAK,
    reconcileIntervalMs: 0,
  })
  store.observeTokenUsage(
    { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 },
    'deepseek-v4-flash',
  )
  store.observeTokenUsage(
    { uncachedInputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 },
    'deepseek-v4-pro',
  )
  const agg = aggregateLifetime(store.getState(), OFF_PEAK, nowReturning(t))
  assert.equal(agg.inCacheMiss, 2000)
  assert.equal(agg.out, 1000)
  store.dispose()
})

test('aggregateToday returns zero when there is no data for today', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const store = new UsageStore({
    storage,
    now: nowReturning(t),
    pricing: OFF_PEAK,
    reconcileIntervalMs: 0,
  })
  const agg = aggregateToday(store.getState(), OFF_PEAK, nowReturning(t))
  assert.equal(agg.inCacheMiss, 0)
  assert.equal(agg.out, 0)
  assert.equal(agg.hasPricing, false)
  store.dispose()
})

test('aggregateDaily returns a gap-free chronological seven-day series', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const store = new UsageStore({ storage, now: nowReturning(t), pricing: OFF_PEAK, reconcileIntervalMs: 0 })
  store.observeTokenUsage(
    { uncachedInputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 50 },
    'deepseek-chat',
    'session-chart',
    'deepseek-official',
  )
  const series = aggregateDaily(store.getState(), OFF_PEAK, nowReturning(t), 7)
  assert.equal(series.length, 7)
  assert.ok(series.every((point, index) => index === 0 || point.date > series[index - 1].date))
  assert.equal(series.at(-1)?.aggregate.inCacheMiss, 200)
  assert.equal(series.at(-1)?.aggregate.inCacheHit, 100)
  store.dispose()
})

test('aggregateBreakdown keeps billing provider and model identity', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const store = new UsageStore({ storage, now: nowReturning(t), pricing: OFF_PEAK, reconcileIntervalMs: 0 })
  store.observeTokenUsage(
    { uncachedInputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 200 },
    'MiniMax-M3',
    'session-breakdown',
    'minimax-cn',
  )
  const rows = aggregateBreakdown(store.getState(), OFF_PEAK, nowReturning(t))
  assert.equal(rows[0]?.provider, 'minimax-cn')
  assert.equal(rows[0]?.model, 'MiniMax-M3')
  assert.equal(rows[0]?.aggregate.out, 200)
  store.dispose()
})

test('Host ledger replaces the local mirror and can be exported for compatibility migration', () => {
  const storage = new MemoryStorage()
  const store = new UsageStore({ storage, now: nowReturning(Date.now()), pricing: OFF_PEAK, reconcileIntervalMs: 0 })
  store.replaceFromLedger([{
    id: 'session-ledger:1:0',
    sessionId: 'session-ledger',
    turn: 1,
    step: 0,
    seq: 9,
    occurredAt: Date.now(),
    routeProvider: 'openrouter',
    billingProvider: 'openrouter',
    model: 'deepseek/deepseek-chat',
    tokens: { uncachedInputTokens: 400, cacheReadTokens: 100, cacheWriteTokens: 20, outputTokens: 80 },
    source: 'session-log',
  }])
  const rows = aggregateBreakdown(store.getState(), OFF_PEAK, Date.now)
  assert.equal(rows[0]?.provider, 'openrouter')
  assert.equal(rows[0]?.aggregate.inCacheMiss, 400)
  assert.deepEqual(store.exportLegacyRows()[0]?.tokens, {
    uncachedInputTokens: 400,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    outputTokens: 80,
  })
  store.dispose()
})

test('Host summary replaces the mirror with totals independent of the visible ledger page', () => {
  const storage = new MemoryStorage()
  const now = Date.now()
  const store = new UsageStore({ storage, now: nowReturning(now), pricing: OFF_PEAK, reconcileIntervalMs: 0 })
  store.replaceFromSummary([{
    date: localDateString(now),
    billingProvider: 'openrouter',
    model: 'deepseek/deepseek-chat',
    calls: 42,
    tokens: { uncachedInputTokens: 4_200, cacheReadTokens: 900, cacheWriteTokens: 100, outputTokens: 700 },
  }])
  const rows = aggregateBreakdown(store.getState(), OFF_PEAK, nowReturning(now))
  assert.equal(rows[0]?.provider, 'openrouter')
  assert.equal(rows[0]?.aggregate.inCacheMiss, 4_200)
  assert.equal(rows[0]?.aggregate.inCacheHit, 900)
  assert.equal(rows[0]?.aggregate.out, 700)
  store.dispose()
})

test('aggregates report partial pricing coverage instead of treating known cost as complete', () => {
  const storage = new MemoryStorage()
  const now = Date.now()
  const partial: PricingTable = {
    default: { inputCacheHitPerMTokCNY: 0, inputCacheMissPerMTokCNY: 0, outputPerMTokCNY: 0 },
    overrides: {
      'priced-model': { inputCacheHitPerMTokCNY: 1, inputCacheMissPerMTokCNY: 2, outputPerMTokCNY: 3 },
    },
    peakHours: { weekdays: [], windows: [], timezone: 'Asia/Shanghai' },
  }
  const store = new UsageStore({ storage, now: nowReturning(now), pricing: partial, reconcileIntervalMs: 0 })
  store.replaceFromSummary([
    {
      date: localDateString(now),
      billingProvider: 'provider-a',
      model: 'priced-model',
      calls: 1,
      tokens: { uncachedInputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
    },
    {
      date: localDateString(now),
      billingProvider: 'provider-b',
      model: 'unpriced-model',
      calls: 1,
      tokens: { uncachedInputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 },
    },
  ])
  const result = aggregateLifetime(store.getState(), partial, nowReturning(now))
  assert.equal(result.hasPricing, true)
  assert.equal(result.hasUnpricedUsage, true)
  store.dispose()
})

test('UsageStore survives a corrupt localStorage value', () => {
  const storage = new MemoryStorage()
  storage.data = 'not json {{'
  const store = new UsageStore({
    storage,
    now: nowReturning(Date.UTC(2026, 0, 22, 10, 0, 0)),
    pricing: OFF_PEAK,
    reconcileIntervalMs: 0,
  })
  assert.deepEqual(store.getState(), { days: [], baselines: {} })
  store.observeTokenUsage(
    { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  store.dispose()
  const parsed = JSON.parse(storage.data!) as { days: { byModel: Record<string, { uncachedInputTokens: number }> }[] }
  assert.equal(parsed.days[0].byModel['deepseek-v4-flash'].uncachedInputTokens, 100)
})

test('negative diffs clamp to 0 (defensive against session restart)', () => {
  const storage = new MemoryStorage()
  const t = Date.UTC(2026, 0, 22, 10, 0, 0)
  const store = new UsageStore({
    storage,
    now: nowReturning(t),
    pricing: OFF_PEAK,
    reconcileIntervalMs: 0,
  })
  store.observeTokenUsage(
    { uncachedInputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  // Totals regressed — store should not produce a negative delta.
  store.observeTokenUsage(
    { uncachedInputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'deepseek-v4-flash',
  )
  store.dispose()
  const parsed = JSON.parse(storage.data!) as { days: { byModel: Record<string, { uncachedInputTokens: number }> }[] }
  assert.equal(parsed.days[0].byModel['deepseek-v4-flash'].uncachedInputTokens, 1000)
})

test('observeTokenUsage with model=null is a no-op even if totals are non-zero', () => {
  const storage = new MemoryStorage()
  const store = new UsageStore({
    storage,
    now: nowReturning(Date.UTC(2026, 0, 22, 10, 0, 0)),
    pricing: OFF_PEAK,
    reconcileIntervalMs: 0,
  })
  store.observeTokenUsage(
    { uncachedInputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    null,
  )
  store.dispose()
  const parsed = storage.data === null ? null : JSON.parse(storage.data) as { days: { byModel: Record<string, unknown> }[] }
  if (parsed !== null) {
    // If anything was written, it should NOT carry model attribution.
    assert.equal(parsed.days.length, 0, 'null model should not write any bucket')
  }
})

test('ZERO_USAGE sums cleanly with another zero usage', () => {
  assert.deepEqual(addUsage(ZERO_USAGE, ZERO_USAGE), ZERO_USAGE)
  assert.deepEqual(diffUsage(ZERO_USAGE, ZERO_USAGE), ZERO_USAGE)
})
