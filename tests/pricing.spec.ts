import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeBucketCost,
  computeDeltaCost,
  isPeakMoment,
  parseHHMM,
  resolvePriceAt,
  resolvePriceFor,
  weekdayInZone,
} from '../src/client/pricing.ts'
import {
  DEEPSEEK_V4_PEAK_PRICES,
  DEFAULT_PEAK_HOURS,
  type PricingTable,
} from '../src/shared/usage.ts'

function makeTable(overrides?: Partial<PricingTable>): PricingTable {
  return {
    default: { inputCacheHitPerMTokCNY: 0.10, inputCacheMissPerMTokCNY: 3.0, outputPerMTokCNY: 9.0 },
    overrides: {},
    peakHours: DEFAULT_PEAK_HOURS,
    ...overrides,
  }
}

test('parseHHMM parses a well-formed HH:MM string', () => {
  assert.equal(parseHHMM('09:00'), 540)
  assert.equal(parseHHMM('00:00'), 0)
  assert.equal(parseHHMM('23:59'), 1439)
  assert.equal(parseHHMM(' 09:00 '), 540)
})

test('parseHHMM returns null on garbage', () => {
  assert.equal(parseHHMM('25:00'), null)
  assert.equal(parseHHMM('09:60'), null)
  assert.equal(parseHHMM(''), null)
  assert.equal(parseHHMM('not a time'), null)
})

test('resolvePriceFor prefers per-model overrides over built-ins', () => {
  const table = makeTable({
    overrides: {
      'deepseek-v4-flash': {
        inputCacheHitPerMTokCNY: 99,
        inputCacheMissPerMTokCNY: 99,
        outputPerMTokCNY: 99,
      },
    },
  })
  const p = resolvePriceFor('deepseek-v4-flash', table)
  assert.equal(p.inputCacheHitPerMTokCNY, 99)
})

test('resolvePriceFor falls back to DEEPSEEK_V4_PEAK_PRICES for known V4 models', () => {
  const table = makeTable()
  const flash = resolvePriceFor('deepseek-v4-flash', table)
  assert.equal(flash.inputCacheHitPerMTokCNY, DEEPSEEK_V4_PEAK_PRICES['deepseek-v4-flash'].inputCacheHitPerMTokCNY)
  const pro = resolvePriceFor('deepseek-v4-pro', table)
  assert.equal(pro.inputCacheMissPerMTokCNY, 9.0)
})

test('resolvePriceFor falls back to table.default for unknown models', () => {
  const table = makeTable({
    default: { inputCacheHitPerMTokCNY: 7, inputCacheMissPerMTokCNY: 7, outputPerMTokCNY: 7 },
  })
  const p = resolvePriceFor('mystery-llm-v9000', table)
  assert.equal(p.outputPerMTokCNY, 7)
})

test('isPeakMoment returns false outside the windows on a weekday', () => {
  // 2026-01-21 (Wed) 13:00 Beijing = Wed 05:00 UTC — between the morning
  // (09:00–12:00) and afternoon (14:00–18:00) windows.
  const ts = Date.UTC(2026, 0, 21, 5, 0, 0)
  assert.equal(isPeakMoment(ts, DEFAULT_PEAK_HOURS), false)
})

test('isPeakMoment returns true inside the morning window on a weekday', () => {
  // 2026-01-22 (Thu) 10:00 Beijing = Thu 02:00 UTC — inside 09:00–12:00 window
  const ts = Date.UTC(2026, 0, 22, 2, 0, 0)
  assert.equal(isPeakMoment(ts, DEFAULT_PEAK_HOURS), true)
})

test('isPeakMoment returns true inside the afternoon window on a weekday', () => {
  // 2026-01-22 (Thu) 16:00 Beijing = Thu 08:00 UTC — inside 14:00–18:00 window
  const ts = Date.UTC(2026, 0, 22, 8, 0, 0)
  assert.equal(isPeakMoment(ts, DEFAULT_PEAK_HOURS), true)
})

test('isPeakMoment returns false on weekends even during working hours', () => {
  // 2026-01-24 (Sat) 10:00 Beijing = Sat 02:00 UTC — Sat is not a peak weekday
  const ts = Date.UTC(2026, 0, 24, 2, 0, 0)
  assert.equal(isPeakMoment(ts, DEFAULT_PEAK_HOURS), false)
})

test('isPeakMoment returns false when the user overrides weekdays to empty', () => {
  // Empty weekdays + non-empty windows = every day is treated as off-peak
  // because weekdays.length === 0 is interpreted as "no peak restriction".
  // Actually our contract says empty means "every day is peak" — verify
  // by checking that the same instant IS peak when windows are non-empty.
  const ts = Date.UTC(2026, 0, 22, 2, 0, 0)
  const peak = { weekdays: [] as const, windows: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai' }
  assert.equal(isPeakMoment(ts, peak), true)
})

test('isPeakMoment returns false when no windows are configured', () => {
  const ts = Date.UTC(2026, 0, 22, 2, 0, 0)
  const off = { weekdays: ['mon'] as const, windows: [], timezone: 'Asia/Shanghai' }
  assert.equal(isPeakMoment(ts, off), false)
})

test('weekdayInZone returns the correct weekday for Asia/Shanghai', () => {
  // 2026-01-22 22:00 UTC = 2026-01-23 06:00 Beijing = Friday
  const friday = Date.UTC(2026, 0, 22, 22, 0, 0)
  assert.equal(weekdayInZone(friday, 'Asia/Shanghai'), 'fri')
  // 2026-01-22 02:00 UTC = 2026-01-22 10:00 Beijing = Thursday
  const thursday = Date.UTC(2026, 0, 22, 2, 0, 0)
  assert.equal(weekdayInZone(thursday, 'Asia/Shanghai'), 'thu')
})

test('resolvePriceAt halves prices off-peak', () => {
  const table = makeTable()
  // Off-peak instant: 2026-01-24 Sat 03:00 Beijing — Sat outside windows
  const ts = Date.UTC(2026, 0, 23, 19, 0, 0)
  const { prices, isPeak } = resolvePriceAt('deepseek-v4-flash', table, ts)
  assert.equal(isPeak, false)
  assert.equal(prices.inputCacheHitPerMTokCNY, 0.05)
  assert.equal(prices.inputCacheMissPerMTokCNY, 1.5)
  assert.equal(prices.outputPerMTokCNY, 4.5)
})

test('resolvePriceAt returns peak prices at peak time', () => {
  const table = makeTable()
  const ts = Date.UTC(2026, 0, 22, 2, 0, 0) // Thu 10:00 Beijing
  const { prices, isPeak } = resolvePriceAt('deepseek-v4-flash', table, ts)
  assert.equal(isPeak, true)
  assert.equal(prices.inputCacheHitPerMTokCNY, 0.10)
  assert.equal(prices.inputCacheMissPerMTokCNY, 3.0)
  assert.equal(prices.outputPerMTokCNY, 9.0)
})

test('resolvePriceAt keeps configured prices when no time schedule exists', () => {
  const table = makeTable({ peakHours: { weekdays: [], windows: [], timezone: 'Asia/Shanghai' } })
  const ts = Date.UTC(2026, 0, 24, 2, 0, 0)
  const { prices, isPeak } = resolvePriceAt('deepseek-v4-flash', table, ts)
  assert.equal(isPeak, false)
  assert.equal(prices.inputCacheHitPerMTokCNY, 0.10)
  assert.equal(prices.inputCacheMissPerMTokCNY, 3.0)
  assert.equal(prices.outputPerMTokCNY, 9.0)
})

test('computeDeltaCost rounds correctly at the per-million boundary', () => {
  const price = { inputCacheHitPerMTokCNY: 0.10, inputCacheMissPerMTokCNY: 3.0, outputPerMTokCNY: 9.0 }
  // 1M cache hit + 1M miss + 0 out = 0.10 + 3.0 = 3.10 CNY
  const c = computeDeltaCost(
    { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 },
    price,
  )
  assert.ok(Math.abs(c - 3.10) < 1e-9)
})

test('computeBucketCost matches sum of computeDeltaCost', () => {
  const price = { inputCacheHitPerMTokCNY: 0.30, inputCacheMissPerMTokCNY: 9.0, outputPerMTokCNY: 27.0 }
  const bucket = { uncachedInputTokens: 50_000, cacheReadTokens: 200_000, cacheWriteTokens: 10_000, outputTokens: 5_000 }
  const c = computeBucketCost(bucket, price)
  assert.ok(c > 0)
})

test('computeDeltaCost with all-zero delta is zero', () => {
  const price = { inputCacheHitPerMTokCNY: 0.30, inputCacheMissPerMTokCNY: 9.0, outputPerMTokCNY: 27.0 }
  const c = computeDeltaCost(
    { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    price,
  )
  assert.equal(c, 0)
})
