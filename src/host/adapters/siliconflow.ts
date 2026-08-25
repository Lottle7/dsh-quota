/** SiliconFlow account-balance adapter. */

import type { QuotaAdapter, QuotaAdapterContext } from "./base.ts"
import { pickCredential, safeFetch, statusFromHttp } from "./base.ts"
import type { MoneyBalance, ProviderCapabilities, QuotaSnapshot } from "../../shared/types.ts"
import { isObject, parseMoneyOrUndefined } from "../../shared/schemas.ts"

export interface SiliconFlowAdapterOptions {
  endpoint?: string
}

const CREDENTIAL_REFS = ["SILICONFLOW_API_KEY", "SILICONFLOW_KEY"] as const

export function createSiliconFlowAdapter(opts: SiliconFlowAdapterOptions = {}): QuotaAdapter {
  const endpoint = opts.endpoint ?? "https://api.siliconflow.cn/v1/user/info"
  return {
    id: "siliconflow",
    displayName: "SiliconFlow",
    credentialRefs: [...CREDENTIAL_REFS],
    supported: true,
    async fetch(ctx: QuotaAdapterContext): Promise<QuotaSnapshot> {
      const fetchedAt = new Date().toISOString()
      const capabilities: ProviderCapabilities = { balance: true, quota: false, usage: false }
      const cred = await pickCredential(CREDENTIAL_REFS, ctx)
      if (cred === undefined) return result("not-configured", "SILICONFLOW_API_KEY is not configured", fetchedAt, capabilities)
      let response
      try {
        response = await safeFetch({
          url: endpoint,
          headers: { authorization: `Bearer ${cred.value}`, accept: "application/json" },
          signal: ctx.signal,
        })
      } catch {
        return result("network-error", "SiliconFlow network request failed", fetchedAt, capabilities)
      }
      if (!response.ok) {
        const status = statusFromHttp(response.status)
        const message = status === "auth-error"
          ? "Authentication failed — check SILICONFLOW_API_KEY"
          : status === "rate-limited" ? "SiliconFlow rate-limited this request" : `HTTP ${response.status}`
        return result(status, message, fetchedAt, capabilities)
      }
      let body: unknown
      try { body = JSON.parse(response.text) } catch {
        return result("error", "Malformed JSON response", fetchedAt, capabilities)
      }
      if (!isObject(body)) return result("error", "SiliconFlow response is not an object", fetchedAt, capabilities)
      const data = isObject(body.data) ? body.data : body
      const total = firstNumber(data, ["totalBalance", "total_balance", "balance"])
      const charge = firstNumber(data, ["chargeBalance", "charge_balance"])
      const granted = firstNumber(data, ["balance", "giftBalance", "gift_balance"])
      if (total === undefined && charge === undefined && granted === undefined) {
        return result("error", "SiliconFlow balance fields are missing", fetchedAt, capabilities)
      }
      const normalizedTotal = total ?? (charge ?? 0) + (granted ?? 0)
      const balances: MoneyBalance[] = [{
        currency: "CNY",
        total: normalizedTotal,
        toppedUp: charge,
        granted: granted !== undefined && granted !== normalizedTotal ? granted : undefined,
      }]
      return {
        providerId: "siliconflow",
        providerDisplayName: "SiliconFlow",
        status: "ok",
        balances,
        fetchedAt,
        capabilities,
      }
    },
  }
}

function firstNumber(data: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = parseMoneyOrUndefined(data[key])
    if (value !== undefined) return value
  }
  return undefined
}

function result(
  status: QuotaSnapshot["status"],
  message: string,
  fetchedAt: string,
  capabilities: ProviderCapabilities,
): QuotaSnapshot {
  return { providerId: "siliconflow", providerDisplayName: "SiliconFlow", status, message, fetchedAt, capabilities }
}
