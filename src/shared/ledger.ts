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

/** Safe filters accepted by the Host ledger and CSV export endpoints. */
export interface UsageLedgerQuery {
  days?: number
  limit?: number
  cursor?: string
  billingProvider?: string
  model?: string
  sessionId?: string
  source?: UsageLedgerSource
  search?: string
}

/** Aggregate bucket used by charts and rankings independently of page size. */
export interface UsageSummaryBucket {
  date: string
  billingProvider: string
  model: string
  calls: number
  tokens: TokenUsageTotals
}

export interface UsageLedgerSummary {
  calls: number
  sessionCount: number
  tokens: TokenUsageTotals
  buckets: UsageSummaryBucket[]
}

/** Host response used by the browser's aggregate and per-call surfaces. */
export interface UsageLedgerResponse {
  entries: UsageLedgerEntry[]
  /** Opaque cursor for the next page; null means the page is complete. */
  nextCursor: string | null
  hasMore: boolean
  /** Complete filtered totals; never truncated to the entry page size. */
  summary: UsageLedgerSummary
  /** Backward-compatible alias for summary.sessionCount. */
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
