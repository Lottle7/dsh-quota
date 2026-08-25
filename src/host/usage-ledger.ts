import { z } from "zod"
import type {
  LegacyUsageImportResult,
  LegacyUsageImportRow,
  UsageBackfillState,
  UsageLedgerEntry,
  UsageLedgerQuery,
  UsageLedgerResponse,
  UsageLedgerSummary,
  UsageSummaryBucket,
} from "../shared/ledger.ts"
import type { TokenUsageTotals } from "../shared/usage.ts"
import { ZERO_USAGE, diffUsage } from "../shared/usage.ts"

interface SessionIdentity {
  createdAt: number
  cwd?: string
}

interface RouteCursor {
  routeProvider: string
  model: string
}

interface StoredSessionUsage {
  identity: SessionIdentity
  revision?: string
  lastSeq: number
  cursor: RouteCursor | null
  entries: Record<string, UsageLedgerEntry>
  updatedAt: number
}

interface SessionHeaderLike {
  id: string
  createdAt: number
  cwd?: string
}

export interface SessionEventLike {
  seq: number
  time: number
  type: string
  data: unknown
}

export interface SessionLike {
  id: string
  header: SessionHeaderLike
  events: readonly SessionEventLike[]
}

export interface SessionPersistenceLike {
  listSnapshots(signal?: AbortSignal): Promise<Array<{ header: SessionHeaderLike; revision: unknown }>>
  inspect(id: string, signal?: AbortSignal): Promise<{ meta: SessionHeaderLike; events: readonly SessionEventLike[] }>
}

export interface SessionStoreLike {
  list(): SessionLike[]
}

interface KvTableLike<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

interface UsageDomainLike {
  table(name: string): KvTableLike<unknown>
  close(): Promise<void>
}

export interface StorageDomainLike {
  open(spec: unknown): Promise<UsageDomainLike>
}

export interface UsageLedgerLogger {
  warn(message: string): void
}

export interface UsageLedgerOptions {
  storageDomain: StorageDomainLike
  sessionPersistence: SessionPersistenceLike
  sessions: SessionStoreLike
  resolveBillingProvider(routeProvider: string, model: string): string
  retainedDays?: number
  now?: () => number
  logger?: UsageLedgerLogger
}

const tokenTotalsSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cacheReadTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cacheWriteTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

const ledgerEntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  turn: z.number().int().nonnegative().nullable(),
  step: z.number().int().nonnegative().nullable(),
  seq: z.number().int().nonnegative().nullable(),
  occurredAt: z.number().int().nonnegative(),
  routeProvider: z.string(),
  billingProvider: z.string(),
  model: z.string(),
  tokens: tokenTotalsSchema,
  source: z.union([z.literal("session-log"), z.literal("browser-migration")]),
}).strict()

const sessionRowSchema = z.object({
  identity: z.object({ createdAt: z.number().int().nonnegative(), cwd: z.string().optional() }).strict(),
  revision: z.string().optional(),
  lastSeq: z.number().int().min(-1),
  cursor: z.object({ routeProvider: z.string(), model: z.string() }).strict().nullable(),
  entries: z.record(z.string(), ledgerEntrySchema),
  updatedAt: z.number().int().nonnegative(),
}).strict()

/** Plain DomainSpec shape; the mounted DSH storage-domain service validates it. */
export const USAGE_LEDGER_DOMAIN_SPEC = {
  name: "dsh_quota_ledger",
  version: 1,
  tables: {
    sessions: { valueSchema: sessionRowSchema },
    imports: { valueSchema: ledgerEntrySchema },
  },
} as const

const DAY_MS = 86_400_000
const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 200

interface NormalizedUsageQuery {
  cutoff: number
  limit: number
  cursor?: string
  billingProvider?: string
  model?: string
  sessionId?: string
  source?: UsageLedgerEntry["source"]
  search?: string
}

interface SortableUsageEntry {
  occurredAt: number
  seq: number | null
  id: string
}

/** Durable Host-side Token ledger backed by DSH's official storage-domain. */
export class HostUsageLedger {
  private readonly sessionTable: KvTableLike<StoredSessionUsage>
  private readonly importTable: KvTableLike<UsageLedgerEntry>
  private readonly now: () => number
  private readonly retainedDays: number
  private readonly tails = new Map<string, Promise<void>>()
  private backfillPromise: Promise<void> | null = null
  private backfill: UsageBackfillState = {
    status: "idle",
    scanned: 0,
    total: 0,
    lastCompletedAt: null,
  }

  private constructor(
    private readonly domain: UsageDomainLike,
    private readonly options: UsageLedgerOptions,
  ) {
    this.sessionTable = domain.table("sessions") as KvTableLike<StoredSessionUsage>
    this.importTable = domain.table("imports") as KvTableLike<UsageLedgerEntry>
    this.now = options.now ?? Date.now
    this.retainedDays = clampInteger(options.retainedDays ?? 90, 30, 3650)
  }

  static async open(options: UsageLedgerOptions): Promise<HostUsageLedger> {
    const domain = await options.storageDomain.open(USAGE_LEDGER_DOMAIN_SPEC)
    return new HostUsageLedger(domain, options)
  }

  close(): Promise<void> {
    return this.domain.close()
  }

  /** Fire-and-observe a live Session event; writes are serialized per Session. */
  observeLive(session: SessionLike, event: SessionEventLike): void {
    if (!isUsageEvent(event)) return
    void this.enqueue(session.id, async () => {
      const existing = this.sessionTable.get(session.id)
      const identity = identityOf(session.header)
      const base = existing !== undefined && sameIdentity(existing.identity, identity)
        ? existing
        : emptySessionRow(identity, this.now())
      const unseen = session.events.filter((item) => item.seq > base.lastSeq && item.seq <= event.seq)
      const next = foldSessionUsage(base, unseen, session.id, this.options.resolveBillingProvider, this.now())
      pruneEntries(next.entries, this.cutoff())
      await this.sessionTable.put(session.id, next)
    }).catch(() => undefined)
  }

  /** Scan every materialized Session without resuming an Agent. */
  startBackfill(): Promise<void> {
    if (this.backfillPromise !== null) return this.backfillPromise
    this.backfillPromise = this.runBackfill().finally(() => { this.backfillPromise = null })
    return this.backfillPromise
  }

  private async runBackfill(): Promise<void> {
    this.backfill = { ...this.backfill, status: "scanning", scanned: 0, total: 0, message: undefined }
    try {
      const snapshots = await this.options.sessionPersistence.listSnapshots()
      this.backfill = { ...this.backfill, total: snapshots.length }
      const liveById = new Map(this.options.sessions.list().map((session) => [session.id, session]))
      for (const snapshot of snapshots) {
        await this.enqueue(snapshot.header.id, async () => {
          const identity = identityOf(snapshot.header)
          const revision = String(snapshot.revision)
          const previous = this.sessionTable.get(snapshot.header.id)
          if (previous !== undefined && sameIdentity(previous.identity, identity) && previous.revision === revision) {
            const trimmed = { ...previous, entries: { ...previous.entries } }
            if (pruneEntries(trimmed.entries, this.cutoff())) await this.sessionTable.put(snapshot.header.id, trimmed)
            return
          }
          const live = liveById.get(snapshot.header.id)
          const inspection = live === undefined
            ? await this.options.sessionPersistence.inspect(snapshot.header.id)
            : { meta: live.header, events: live.events }
          const base = emptySessionRow(identityOf(inspection.meta), this.now())
          const next = foldSessionUsage(base, inspection.events, snapshot.header.id, this.options.resolveBillingProvider, this.now())
          next.revision = revision
          pruneEntries(next.entries, this.cutoff())
          await this.sessionTable.put(snapshot.header.id, next)
        })
        this.backfill = { ...this.backfill, scanned: this.backfill.scanned + 1 }
      }
      await this.pruneImports()
      this.backfill = {
        status: "ready",
        scanned: snapshots.length,
        total: snapshots.length,
        lastCompletedAt: this.now(),
      }
    } catch (error) {
      this.options.logger?.warn(`dsh-quota usage backfill failed: ${safeError(error)}`)
      this.backfill = {
        ...this.backfill,
        status: "error",
        message: "Historical usage synchronization failed. Retry from the quota center.",
      }
    }
  }

  query(input: UsageLedgerQuery = {}): UsageLedgerResponse {
    const query = this.normalizeQuery(input)
    const allEntries = this.collect(query)
    const summary = summarizeUsage(allEntries)
    const start = pageStart(allEntries, query.cursor)
    const entries = allEntries.slice(start, start + query.limit)
    const hasMore = start + entries.length < allEntries.length
    const nextCursor = hasMore && entries.length > 0 ? encodeCursor(entries[entries.length - 1]) : null
    return {
      entries,
      nextCursor,
      hasMore,
      summary,
      sessionCount: summary.sessionCount,
      retainedDays: this.retainedDays,
      backfill: { ...this.backfill },
    }
  }

  /** Export every filtered row, independently of UI pagination. */
  exportCsv(input: UsageLedgerQuery = {}): string {
    const query = this.normalizeQuery({ ...input, cursor: undefined, limit: MAX_PAGE_SIZE })
    const lines = [
      [
        "occurred_at", "session_id", "turn", "step", "route_provider", "billing_provider", "model",
        "uncached_input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "total_tokens", "source",
      ].join(","),
    ]
    for (const entry of this.collect(query)) {
      lines.push([
        new Date(entry.occurredAt).toISOString(),
        entry.sessionId,
        entry.turn ?? "",
        entry.step ?? "",
        entry.routeProvider,
        entry.billingProvider,
        entry.model,
        entry.tokens.uncachedInputTokens,
        entry.tokens.cacheReadTokens,
        entry.tokens.cacheWriteTokens,
        entry.tokens.outputTokens,
        totalTokens(entry.tokens),
        entry.source,
      ].map(csvCell).join(","))
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`
  }

  private normalizeQuery(input: UsageLedgerQuery): NormalizedUsageQuery {
    const safeDays = clampInteger(input.days ?? 30, 1, this.retainedDays)
    const cursor = cleanQueryString(input.cursor, 1_024)
    const billingProvider = cleanQueryString(input.billingProvider, 160)?.toLowerCase()
    const model = cleanQueryString(input.model, 320)?.toLowerCase()
    const sessionId = cleanQueryString(input.sessionId, 160)?.toLowerCase()
    const search = cleanQueryString(input.search, 160)?.toLowerCase()
    return {
      cutoff: this.now() - safeDays * DAY_MS,
      limit: clampInteger(input.limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
      ...(cursor === undefined ? {} : { cursor }),
      ...(billingProvider === undefined ? {} : { billingProvider }),
      ...(model === undefined ? {} : { model }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(input.source === "session-log" || input.source === "browser-migration" ? { source: input.source } : {}),
      ...(search === undefined ? {} : { search }),
    }
  }

  private collect(query: NormalizedUsageQuery): UsageLedgerEntry[] {
    const entries: UsageLedgerEntry[] = []
    for (const [, row] of this.sessionTable.entries()) {
      for (const entry of Object.values(row.entries)) {
        if (matchesQuery(entry, query)) entries.push(entry)
      }
    }
    for (const [, entry] of this.importTable.entries()) {
      if (totalTokens(entry.tokens) > 0 && matchesQuery(entry, query)) entries.push(entry)
    }
    entries.sort(compareEntries)
    return entries
  }

  /**
   * Migrate the old browser aggregates without double-counting Sessions that
   * the Host history already covers. The synthetic row stores only the
   * positive remainder above native history for the same day/provider/model.
   */
  async importLegacy(rows: readonly LegacyUsageImportRow[]): Promise<LegacyUsageImportResult> {
    // Native Session history is authoritative. Finish its scan before
    // calculating a browser-only remainder, otherwise a startup race could
    // temporarily count the same tokens twice.
    await this.startBackfill()
    const acceptedRows = rows.slice(0, 2_000)
    let stored = 0
    let coveredBySessionHistory = 0
    for (const row of acceptedRows) {
      const native = this.nativeBucket(row.date, row.provider, row.model)
      const remainder = diffUsage(row.tokens, native)
      const key = importKey(row.date, row.provider, row.model)
      if (totalTokens(remainder) === 0) {
        if (totalTokens(row.tokens) > 0) coveredBySessionHistory += 1
        await this.importTable.delete(key)
        continue
      }
      const entry: UsageLedgerEntry = {
        id: `legacy:${key}`,
        sessionId: "browser-migration",
        turn: null,
        step: null,
        seq: null,
        occurredAt: localDateNoon(row.date),
        routeProvider: row.provider,
        billingProvider: row.provider,
        model: row.model,
        tokens: remainder,
        source: "browser-migration",
      }
      await this.importTable.put(key, entry)
      stored += 1
    }
    return { accepted: acceptedRows.length, stored, coveredBySessionHistory }
  }

  private nativeBucket(date: string, provider: string, model: string): TokenUsageTotals {
    const total = { ...ZERO_USAGE }
    for (const [, row] of this.sessionTable.entries()) {
      for (const entry of Object.values(row.entries)) {
        if (
          localDateString(entry.occurredAt) !== date ||
          entry.billingProvider !== provider ||
          entry.model !== model
        ) continue
        total.uncachedInputTokens += entry.tokens.uncachedInputTokens
        total.cacheReadTokens += entry.tokens.cacheReadTokens
        total.cacheWriteTokens += entry.tokens.cacheWriteTokens
        total.outputTokens += entry.tokens.outputTokens
      }
    }
    return total
  }

  private cutoff(): number {
    return this.now() - this.retainedDays * DAY_MS
  }

  private async pruneImports(): Promise<void> {
    const cutoff = this.cutoff()
    for (const [key, entry] of this.importTable.entries()) {
      if (entry.occurredAt < cutoff) await this.importTable.delete(key)
    }
  }

  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.tails.set(id, next)
    return next.finally(() => {
      if (this.tails.get(id) === next) this.tails.delete(id)
    })
  }
}

/** Fold a Session log suffix into a durable per-step row. Exported for tests. */
export function foldSessionUsage(
  input: StoredSessionUsage,
  events: readonly SessionEventLike[],
  sessionId: string,
  resolveBillingProvider: (routeProvider: string, model: string) => string,
  updatedAt: number,
): StoredSessionUsage {
  const next: StoredSessionUsage = {
    ...input,
    cursor: input.cursor === null ? null : { ...input.cursor },
    entries: { ...input.entries },
    updatedAt,
  }
  let cursor = next.cursor
  let activeTurn: number | null = null
  let activeStep: number | null = null
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) continue
    next.lastSeq = Math.max(next.lastSeq, event.seq)
    const data = recordOf(event.data)
    if (event.type === "step/start") {
      activeTurn = safeNonNegativeInteger(data?.turn)
      activeStep = safeNonNegativeInteger(data?.step)
      continue
    }
    if (event.type === "step/end") {
      activeTurn = null
      activeStep = null
      continue
    }
    if (event.type === "request/context") {
      const routeProvider = safeString(data?.provider, 160)
      const model = safeString(data?.model, 320)
      if (routeProvider !== undefined && model !== undefined) cursor = { routeProvider, model }
      continue
    }
    if (event.type === "request/header") {
      const header = recordOf(data?.header)
      const config = recordOf(header?.config)
      const routeProvider = safeString(config?.provider, 160)
      const model = safeString(config?.model, 320)
      if (routeProvider !== undefined && model !== undefined) cursor = { routeProvider, model }
      continue
    }
    const usage = usageFromEvent(event.type, data)
    if (usage === undefined) continue
    const turn = safeNonNegativeInteger(data?.turn) ?? activeTurn
    const step = safeNonNegativeInteger(data?.step) ?? activeStep
    if (turn === null || step === null) continue
    const routeProvider = cursor?.routeProvider ?? "unknown"
    const model = cursor?.model ?? "unknown"
    const billingProvider = routeProvider === "unknown"
      ? "unknown"
      : safeResolvedProvider(resolveBillingProvider, routeProvider, model)
    const id = `${sessionId}:${turn}:${step}`
    next.entries[`${turn}:${step}`] = {
      id,
      sessionId,
      turn,
      step,
      seq: event.seq,
      occurredAt: Number.isSafeInteger(event.time) && event.time >= 0 ? event.time : updatedAt,
      routeProvider,
      billingProvider,
      model,
      tokens: usage,
      source: "session-log",
    }
  }
  next.cursor = cursor
  return next
}

function usageFromEvent(type: string, data: Record<string, unknown> | undefined): TokenUsageTotals | undefined {
  if (data === undefined) return undefined
  let usage: Record<string, unknown> | undefined
  if (type === "assistant/message") usage = recordOf(data.usage)
  if (type === "assistant/chunk") {
    const chunk = recordOf(data.chunk)
    if (chunk?.type === "usage") usage = recordOf(chunk.usage)
  }
  if (usage === undefined) return undefined
  const values = {
    uncachedInputTokens: safeToken(usage.inputTokens),
    cacheReadTokens: safeToken(usage.cacheReadTokens),
    cacheWriteTokens: safeToken(usage.cacheWriteTokens),
    outputTokens: safeToken(usage.outputTokens),
  }
  return values.uncachedInputTokens === undefined || values.outputTokens === undefined
    ? undefined
    : {
      uncachedInputTokens: values.uncachedInputTokens,
      cacheReadTokens: values.cacheReadTokens ?? 0,
      cacheWriteTokens: values.cacheWriteTokens ?? 0,
      outputTokens: values.outputTokens,
    }
}

function emptySessionRow(identity: SessionIdentity, now: number): StoredSessionUsage {
  return { identity, lastSeq: -1, cursor: null, entries: {}, updatedAt: now }
}

function identityOf(header: SessionHeaderLike): SessionIdentity {
  return { createdAt: header.createdAt, ...(header.cwd === undefined ? {} : { cwd: header.cwd }) }
}

function sameIdentity(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.createdAt === b.createdAt && a.cwd === b.cwd
}

function isUsageEvent(event: SessionEventLike): boolean {
  const data = recordOf(event.data)
  if (event.type === "assistant/message") return recordOf(data?.usage) !== undefined
  if (event.type !== "assistant/chunk") return false
  return recordOf(data?.chunk)?.type === "usage"
}

function safeResolvedProvider(resolve: (routeProvider: string, model: string) => string, route: string, model: string): string {
  try { return safeString(resolve(route, model), 160) ?? "unknown" } catch { return "unknown" }
}

function pruneEntries(entries: Record<string, UsageLedgerEntry>, cutoff: number): boolean {
  let changed = false
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.occurredAt >= cutoff) continue
    delete entries[key]
    changed = true
  }
  return changed
}

function importKey(date: string, provider: string, model: string): string {
  return `${date}:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`
}

function localDateNoon(date: string): number {
  const value = new Date(`${date}T12:00:00`).getTime()
  return Number.isFinite(value) ? value : Date.now()
}

function localDateString(ts: number): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts))
}

function safeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function safeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value.trim()
  return clean.length > 0 && clean.length <= maxLength ? clean : undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function totalTokens(value: TokenUsageTotals): number {
  return value.uncachedInputTokens + value.cacheReadTokens + value.cacheWriteTokens + value.outputTokens
}

function matchesQuery(entry: UsageLedgerEntry, query: NormalizedUsageQuery): boolean {
  if (entry.occurredAt < query.cutoff) return false
  if (query.billingProvider !== undefined && entry.billingProvider.toLowerCase() !== query.billingProvider) return false
  if (query.model !== undefined && entry.model.toLowerCase() !== query.model) return false
  if (query.sessionId !== undefined && entry.sessionId.toLowerCase() !== query.sessionId) return false
  if (query.source !== undefined && entry.source !== query.source) return false
  if (query.search !== undefined) {
    const haystack = `${entry.sessionId}\n${entry.routeProvider}\n${entry.billingProvider}\n${entry.model}`.toLowerCase()
    if (!haystack.includes(query.search)) return false
  }
  return true
}

function summarizeUsage(entries: readonly UsageLedgerEntry[]): UsageLedgerSummary {
  const tokens = { ...ZERO_USAGE }
  const sessions = new Set<string>()
  const buckets = new Map<string, UsageSummaryBucket>()
  for (const entry of entries) {
    tokens.uncachedInputTokens += entry.tokens.uncachedInputTokens
    tokens.cacheReadTokens += entry.tokens.cacheReadTokens
    tokens.cacheWriteTokens += entry.tokens.cacheWriteTokens
    tokens.outputTokens += entry.tokens.outputTokens
    if (entry.source === "session-log") sessions.add(entry.sessionId)
    const date = localDateString(entry.occurredAt)
    const key = `${date}\u0000${entry.billingProvider}\u0000${entry.model}`
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = {
        date,
        billingProvider: entry.billingProvider,
        model: entry.model,
        calls: 0,
        tokens: { ...ZERO_USAGE },
      }
      buckets.set(key, bucket)
    }
    bucket.calls += 1
    bucket.tokens.uncachedInputTokens += entry.tokens.uncachedInputTokens
    bucket.tokens.cacheReadTokens += entry.tokens.cacheReadTokens
    bucket.tokens.cacheWriteTokens += entry.tokens.cacheWriteTokens
    bucket.tokens.outputTokens += entry.tokens.outputTokens
  }
  return {
    calls: entries.length,
    sessionCount: sessions.size,
    tokens,
    buckets: [...buckets.values()].sort((a, b) =>
      b.date.localeCompare(a.date) ||
      a.billingProvider.localeCompare(b.billingProvider) ||
      a.model.localeCompare(b.model)),
  }
}

function compareEntries(a: SortableUsageEntry, b: SortableUsageEntry): number {
  return b.occurredAt - a.occurredAt ||
    (b.seq ?? -1) - (a.seq ?? -1) ||
    a.id.localeCompare(b.id)
}

function pageStart(entries: readonly UsageLedgerEntry[], cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const marker = decodeCursor(cursor)
  if (marker === undefined) return 0
  const exact = entries.findIndex((entry) =>
    entry.occurredAt === marker.occurredAt && entry.seq === marker.seq && entry.id === marker.id)
  if (exact >= 0) return exact + 1
  const next = entries.findIndex((entry) => compareEntries(entry, marker) > 0)
  return next < 0 ? entries.length : next
}

function encodeCursor(entry: SortableUsageEntry): string {
  return Buffer.from(JSON.stringify({ t: entry.occurredAt, s: entry.seq, i: entry.id }), "utf8").toString("base64url")
}

function decodeCursor(value: string): SortableUsageEntry | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { t?: unknown; s?: unknown; i?: unknown }
    if (!Number.isSafeInteger(parsed.t) || (parsed.s !== null && !Number.isSafeInteger(parsed.s)) || typeof parsed.i !== "string") return undefined
    if ((parsed.t as number) < 0 || parsed.i.length === 0 || parsed.i.length > 512) return undefined
    return { occurredAt: parsed.t as number, seq: parsed.s as number | null, id: parsed.i }
  } catch { return undefined }
}

function cleanQueryString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value.trim()
  return clean.length > 0 && clean.length <= maxLength && !/[\u0000-\u001f]/.test(clean) ? clean : undefined
}

function csvCell(value: string | number): string {
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)))
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
