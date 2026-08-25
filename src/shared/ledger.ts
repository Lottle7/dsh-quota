import type { TokenUsageTotals } from "./usage.ts"

/** How a durable usage row entered the Host ledger. */
export type UsageLedgerSource = "session-log" | "browser-migration"

/** One deduplicated model call, or one synthetic legacy-browser remainder. */
export interface UsageLedgerEntry {
  id: string
  sessionId: string
  turn: number | null
  step: number | null
  seq: number | null
  occurredAt: number
  routeProvider: string
  billingProvider: string
  model: string
  tokens: TokenUsageTotals
  source: UsageLedgerSource
}

export interface UsageBackfillState {
  status: "idle" | "scanning" | "ready" | "error"
  scanned: number
  total: number
  lastCompletedAt: number | null
  message?: string
}

/** Host response used by the browser's aggregate and per-call surfaces. */
export interface UsageLedgerResponse {
  entries: UsageLedgerEntry[]
  sessionCount: number
  retainedDays: number
  backfill: UsageBackfillState
}

/** One aggregate bucket imported from the pre-v0.6 browser store. */
export interface LegacyUsageImportRow {
  date: string
  provider: string
  model: string
  tokens: TokenUsageTotals
}

export interface LegacyUsageImportResult {
  accepted: number
  stored: number
  coveredBySessionHistory: number
}
