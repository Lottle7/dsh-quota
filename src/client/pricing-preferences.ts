/** Browser-local model pricing edited from the quota center. */

import type { PriceSet, PricingTable } from "../shared/usage.ts"
import { LOCAL_PRICING_STORAGE_KEY } from "../shared/usage.ts"

export type LocalPriceOverrides = Record<string, PriceSet>

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readLocalPriceOverrides(storage: KeyValueStorage | undefined = browserStorage()): LocalPriceOverrides {
  if (storage === undefined) return {}
  try {
    const raw = storage.getItem(LOCAL_PRICING_STORAGE_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return {}
    const output: LocalPriceOverrides = {}
    for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
      const prices = normalizePriceSet(value)
      if (prices !== undefined && model.trim().length > 0) output[model.trim().toLowerCase()] = prices
    }
    return output
  } catch { return {} }
}

export function writeLocalPriceOverrides(
  overrides: LocalPriceOverrides,
  storage: KeyValueStorage | undefined = browserStorage(),
): void {
  if (storage === undefined) return
  try { storage.setItem(LOCAL_PRICING_STORAGE_KEY, JSON.stringify(overrides)) } catch { /* private mode */ }
}

export function mergePricingTable(host: PricingTable, local: LocalPriceOverrides): PricingTable {
  return { ...host, overrides: { ...host.overrides, ...local } }
}

export function withLocalPrice(
  overrides: LocalPriceOverrides,
  model: string,
  prices: PriceSet | null,
): LocalPriceOverrides {
  const key = model.trim().toLowerCase()
  if (key.length === 0) return overrides
  const next = { ...overrides }
  if (prices === null) delete next[key]
  else next[key] = { ...prices }
  return next
}

function normalizePriceSet(value: unknown): PriceSet | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const input = value as Partial<Record<keyof PriceSet, unknown>>
  const hit = nonNegative(input.inputCacheHitPerMTokCNY)
  const miss = nonNegative(input.inputCacheMissPerMTokCNY)
  const output = nonNegative(input.outputPerMTokCNY)
  if (hit === undefined || miss === undefined || output === undefined) return undefined
  return {
    inputCacheHitPerMTokCNY: hit,
    inputCacheMissPerMTokCNY: miss,
    outputPerMTokCNY: output,
  }
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function browserStorage(): KeyValueStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage } catch { return undefined }
}
