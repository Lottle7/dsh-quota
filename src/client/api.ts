/**
 * Browser-side fetch wrapper for /api/dsh-quota/*.
 *
 * Always uses same-origin credentials; never carries API keys in headers.
 * Errors carry only safe messages (HTTP status + endpoint name).
 */

import type {
  CurrentQuotaResponse,
  ProviderId,
  ProviderListItem,
  QuotaSnapshot,
  SessionSelectionHint,
  SettingsSnapshotResponse,
} from "../shared/types.ts"
import { RPC_PATHS } from "../shared/types.ts"
import type { LegacyUsageImportResult, LegacyUsageImportRow, UsageLedgerQuery, UsageLedgerResponse } from "../shared/ledger.ts"

export class QuotaApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  let data: unknown
  try {
    data = text.length > 0 ? JSON.parse(text) : null
  } catch {
    throw new QuotaApiError(res.status, `Bad JSON from ${res.url}`)
  }
  if (!res.ok) {
    const err = (data as { error?: unknown })?.error
    throw new QuotaApiError(res.status, typeof err === "string" ? err : `HTTP ${res.status}`)
  }
  return data as T
}

export interface QuotaApi {
  listProviders(): Promise<ProviderListItem[]>
  getCurrent(selection?: SessionSelectionHint): Promise<CurrentQuotaResponse>
  getProvider(id: ProviderId): Promise<{ snapshot: QuotaSnapshot; fallback?: QuotaSnapshot }>
  refresh(id?: ProviderId, selection?: SessionSelectionHint): Promise<CurrentQuotaResponse | { snapshot: QuotaSnapshot; fallback?: QuotaSnapshot }>
  getSettings(): Promise<SettingsSnapshotResponse>
  getUsage(query?: UsageLedgerQuery): Promise<UsageLedgerResponse>
  exportUsageCsv(query?: UsageLedgerQuery): Promise<Blob>
  importLegacyUsage(rows: readonly LegacyUsageImportRow[]): Promise<LegacyUsageImportResult>
  backfillUsage(): Promise<void>
}

export function createQuotaApi(base = ""): QuotaApi {
  const url = (p: string): string => `${base}${p}`
  const withSelection = (path: string, selection?: SessionSelectionHint): string => {
    if (selection === undefined) return path
    const search = new URLSearchParams({ provider: selection.provider, model: selection.model })
    if (selection.sessionId !== undefined) search.set("sessionId", selection.sessionId)
    if (selection.reasoningEffort !== undefined) search.set("reasoningEffort", selection.reasoningEffort)
    return `${path}?${search.toString()}`
  }
  return {
    async listProviders() {
      const data = await readJson<{ providers: ProviderListItem[] }>(
        await fetch(url(RPC_PATHS.listProviders), { method: "GET" }),
      )
      return data.providers ?? []
    },
    async getCurrent(selection) {
      return readJson<CurrentQuotaResponse>(
        await fetch(withSelection(url(RPC_PATHS.getCurrent), selection), { method: "GET" }),
      )
    },
    async getProvider(id) {
      const search = new URLSearchParams({ id })
      return readJson<{ snapshot: QuotaSnapshot; fallback?: QuotaSnapshot }>(
        await fetch(`${url(RPC_PATHS.getProvider)}?${search.toString()}`, { method: "GET" }),
      )
    },
    async refresh(id, selection) {
      const jsonPost: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
      if (id !== undefined) {
        const search = new URLSearchParams({ id })
        return readJson<{ snapshot: QuotaSnapshot; fallback?: QuotaSnapshot }>(
          await fetch(`${url(RPC_PATHS.refresh)}?${search.toString()}`, jsonPost),
        )
      }
      return readJson<CurrentQuotaResponse>(
        await fetch(withSelection(url(RPC_PATHS.refresh), selection), jsonPost),
      )
    },
    async getSettings() {
      return readJson<SettingsSnapshotResponse>(
        await fetch(url(RPC_PATHS.getSettings), { method: "GET" }),
      )
    },
    async getUsage(query = {}) {
      const search = usageSearch(query)
      return readJson<UsageLedgerResponse>(
        await fetch(`${url(RPC_PATHS.getUsage)}?${search.toString()}`, { method: "GET" }),
      )
    },
    async exportUsageCsv(query = {}) {
      const search = usageSearch(query)
      const response = await fetch(`${url(RPC_PATHS.exportUsage)}?${search.toString()}`, { method: "GET" })
      if (!response.ok) {
        const message = await response.text()
        throw new QuotaApiError(response.status, message.length > 0 ? message.slice(0, 300) : `HTTP ${response.status}`)
      }
      return response.blob()
    },
    async importLegacyUsage(rows) {
      return readJson<LegacyUsageImportResult>(
        await fetch(url(RPC_PATHS.importUsage), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rows }),
        }),
      )
    },
    async backfillUsage() {
      await readJson<{ accepted: true }>(
        await fetch(url(RPC_PATHS.backfillUsage), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      )
    },
  }
}

function usageSearch(query: UsageLedgerQuery): URLSearchParams {
  const search = new URLSearchParams()
  if (query.days !== undefined) search.set("days", String(query.days))
  if (query.limit !== undefined) search.set("limit", String(query.limit))
  if (query.cursor !== undefined) search.set("cursor", query.cursor)
  if (query.billingProvider !== undefined) search.set("provider", query.billingProvider)
  if (query.model !== undefined) search.set("model", query.model)
  if (query.sessionId !== undefined) search.set("sessionId", query.sessionId)
  if (query.source !== undefined) search.set("source", query.source)
  if (query.search !== undefined) search.set("search", query.search)
  return search
}
