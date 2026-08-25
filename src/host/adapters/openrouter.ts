/** OpenRouter current-key quota and usage adapter. */

import type { QuotaAdapter, QuotaAdapterContext } from "./base.ts"
import { pickCredential, safeFetch, statusFromHttp } from "./base.ts"
import type { ProviderCapabilities, QuotaSnapshot, QuotaWindow } from "../../shared/types.ts"
import { asString, isObject, parseMoneyOrUndefined } from "../../shared/schemas.ts"

export interface OpenRouterAdapterOptions {
  endpoint?: string
}

const CREDENTIAL_REFS = ["OPENROUTER_API_KEY", "OPENROUTER_KEY"] as const

export function createOpenRouterAdapter(opts: OpenRouterAdapterOptions = {}): QuotaAdapter {
  const endpoint = opts.endpoint ?? "https://openrouter.ai/api/v1/key"
  return {
    id: "openrouter",
    displayName: "OpenRouter",
    credentialRefs: [...CREDENTIAL_REFS],
    supported: true,
    async fetch(ctx: QuotaAdapterContext): Promise<QuotaSnapshot> {
      const fetchedAt = new Date().toISOString()
      const capabilities: ProviderCapabilities = { balance: true, quota: true, usage: true }
      const cred = await pickCredential(CREDENTIAL_REFS, ctx)
      if (cred === undefined) {
        return result("not-configured", "OPENROUTER_API_KEY is not configured", fetchedAt, capabilities)
      }
      let response
      try {
        response = await safeFetch({
          url: endpoint,
          headers: { authorization: `Bearer ${cred.value}`, accept: "application/json" },
          signal: ctx.signal,
        })
      } catch (error) {
        return result("network-error", safeMessage(error), fetchedAt, capabilities)
      }
      if (!response.ok) {
        const status = statusFromHttp(response.status)
        const message = status === "auth-error"
          ? "Authentication failed — check OPENROUTER_API_KEY"
          : status === "rate-limited" ? "OpenRouter rate-limited this request" : `HTTP ${response.status}`
        return result(status, message, fetchedAt, capabilities)
      }
      let body: unknown
      try { body = JSON.parse(response.text) } catch {
        return result("error", "Malformed JSON response", fetchedAt, capabilities)
      }
      if (!isObject(body) || !isObject(body.data)) {
        return result("error", "OpenRouter key metadata is missing", fetchedAt, capabilities)
      }
      const data = body.data
      const usage = parseMoneyOrUndefined(data.usage)
      const limit = parseMoneyOrUndefined(data.limit)
      const remaining = parseMoneyOrUndefined(data.limit_remaining)
        ?? (limit !== undefined && usage !== undefined ? Math.max(0, limit - usage) : undefined)
      const usageSummary = {
        currency: "USD",
        total: usage,
        daily: parseMoneyOrUndefined(data.usage_daily),
        weekly: parseMoneyOrUndefined(data.usage_weekly),
        monthly: parseMoneyOrUndefined(data.usage_monthly),
        limit,
        remaining,
        reset: asString(data.limit_reset),
      }
      const quotas: QuotaWindow[] = []
      if (limit !== undefined && limit > 0 && remaining !== undefined) {
        quotas.push({
          id: "key-spend-limit",
          label: `${asString(data.limit_reset) ?? "Key"} spend limit`,
          remaining,
          total: limit,
          unit: "USD",
          remainingRatio: Math.max(0, Math.min(1, remaining / limit)),
        })
      }
      const balances = remaining === undefined ? undefined : [{ currency: "USD", total: remaining }]
      return {
        providerId: "openrouter",
        providerDisplayName: "OpenRouter",
        status: "ok",
        message: asString(data.label) !== undefined ? `Key ${asString(data.label)}` : undefined,
        balances,
        quotas: quotas.length > 0 ? quotas : undefined,
        usage: usageSummary,
        fetchedAt,
        capabilities,
      }
    },
  }
}

function result(
  status: QuotaSnapshot["status"],
  message: string,
  fetchedAt: string,
  capabilities: ProviderCapabilities,
): QuotaSnapshot {
  return { providerId: "openrouter", providerDisplayName: "OpenRouter", status, message, fetchedAt, capabilities }
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Network request failed"
  return /abort|timeout/i.test(error.message) ? "OpenRouter request timed out" : "OpenRouter network request failed"
}
