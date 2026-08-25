/**
 * DeepSeek Official adapter.
 *
 * Public endpoint:
 *   GET https://api.deepseek.com/user/balance
 *   Authorization: Bearer <DEEPSEEK_API_KEY>
 *
 * The adapter normalizes the response into MoneyBalance[] (one per currency).
 * It deliberately returns a "warning" status when the balance is below a
 * soft threshold (configurable through plugin settings; default ¥10).
 *
 * Reference: https://api-docs.deepseek.com/zh-cn/api/get-user-balance
 */

import type { QuotaAdapter, QuotaAdapterContext } from "./base.ts"
import { safeFetch, statusFromHttp, pickCredential, sanitize } from "./base.ts"
import type { MoneyBalance, ProviderCapabilities, QuotaSnapshot } from "../../shared/types.ts"
import { isObject, parseMoneyOrUndefined, requireObject, asString } from "../../shared/schemas.ts"

export interface DeepSeekAdapterOptions {
  /** Override the endpoint (mostly for tests; defaults to the public one). */
  endpoint?: string
  /** Soft warning threshold for the first currency's total balance. */
  warningBelow?: number
}

export function createDeepSeekAdapter(opts: DeepSeekAdapterOptions = {}): QuotaAdapter {
  const endpoint = opts.endpoint ?? "https://api.deepseek.com/user/balance"
  const warningBelow = opts.warningBelow ?? 10

  return {
    id: "deepseek-official",
    displayName: "DeepSeek Official",
    credentialRefs: ["DEEPSEEK_API_KEY"],
    supported: true,

    async fetch(ctx: QuotaAdapterContext): Promise<QuotaSnapshot> {
      const fetchedAt = new Date().toISOString()
      const capabilities: ProviderCapabilities = { balance: true, quota: false }

      const cred = await pickCredential(["DEEPSEEK_API_KEY"], ctx)
      if (cred === undefined) {
        return {
          providerId: "deepseek-official",
          providerDisplayName: "DeepSeek Official",
          status: "not-configured",
          message: "DEEPSEEK_API_KEY is not configured",
          fetchedAt,
          capabilities,
        }
      }

      let response
      try {
        response = await safeFetch({
          url: endpoint,
          method: "GET",
          headers: {
            authorization: `Bearer ${cred.value}`,
            accept: "application/json",
          },
          timeoutMs: 12_000,
          signal: ctx.signal,
        })
      } catch (err) {
        return {
          providerId: "deepseek-official",
          providerDisplayName: "DeepSeek Official",
          status: "network-error",
          message: err instanceof Error ? err.message : String(err),
          fetchedAt,
          capabilities,
        }
      }

      if (response.status === 401 || response.status === 403) {
        return {
          providerId: "deepseek-official",
          providerDisplayName: "DeepSeek Official",
          status: "auth-error",
          message: "Authentication failed — check DEEPSEEK_API_KEY",
          fetchedAt,
          capabilities,
        }
      }
      if (response.status === 429) {
        return {
          providerId: "deepseek-official",
          providerDisplayName: "DeepSeek Official",
          status: "rate-limited",
          message: "DeepSeek rate-limited; retrying later",
          fetchedAt,
          capabilities,
        }
      }
      if (!response.ok) {
        return {
          providerId: "deepseek-official",
          providerDisplayName: "DeepSeek Official",
          status: statusFromHttp(response.status),
          message: `HTTP ${response.status}`,
          fetchedAt,
          capabilities,
        }
      }

      let body: unknown
      try {
        body = JSON.parse(response.text)
      } catch {
        return {
          providerId: "deepseek-official",
          providerDisplayName: "DeepSeek Official",
          status: "error",
          message: "Malformed JSON response",
          fetchedAt,
          capabilities,
        }
      }

      // Schema: { is_available: boolean, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}] }
      const root = requireObject(body, "deepseek.balance")
      const isAvailable = root["is_available"]
      const infosRaw = root["balance_infos"]
      if (!Array.isArray(infosRaw)) {
        return {
          providerId: "deepseek-official",
          providerDisplayName: "DeepSeek Official",
          status: "error",
          message: "balance_infos is missing or not an array",
          fetchedAt,
          capabilities,
        }
      }
      const balances: MoneyBalance[] = []
      for (const entry of infosRaw) {
        if (!isObject(entry)) continue
        const currency = asString(entry["currency"]) ?? ""
        if (currency.length === 0) continue
        const total = parseMoneyOrUndefined(entry["total_balance"])
        if (total === undefined) continue
        balances.push({
          currency,
          total,
          granted: parseMoneyOrUndefined(entry["granted_balance"]),
          toppedUp: parseMoneyOrUndefined(entry["topped_up_balance"]),
        })
      }

      if (isAvailable === false) {
        return {
          providerId: "deepseek-official",
          providerDisplayName: "DeepSeek Official",
          status: "error",
          message: "API reports is_available=false",
          balances: sanitize(balances) as MoneyBalance[],
          fetchedAt,
          capabilities,
        }
      }

      let status: QuotaSnapshot["status"] = "ok"
      if (balances.length === 0) {
        return {
          providerId: "deepseek-official",
          providerDisplayName: "DeepSeek Official",
          status: "error",
          message: "No balance entries in response",
          fetchedAt,
          capabilities,
        }
      }
      if (balances[0].total < warningBelow) {
        status = "warning"
      }
      return {
        providerId: "deepseek-official",
        providerDisplayName: "DeepSeek Official",
        status,
        balances,
        fetchedAt,
        capabilities,
      }
    },
  }
}
