/**
 * MiniMax Token Plan adapter.
 *
 * Supports two regional Coding Plan endpoints:
 *   - International: GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains
 *   - China:          GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains
 *
 * The route resolver picks the China variant when the active DSH route id
 * contains "cn" (e.g. "minimax-cn", "MiniMax-cn"). All other MiniMax routes
 * (or explicit "minimax" with no region hint) hit the international one.
 *
 * The response shape is NOT formally documented. We tolerate three observed
 * variants:
 *   1. { code: 0, data: { "5h": { remaining, total }, weekly: {...}, plan_tier } }
 *   2. { "5-hour": { usage, limit, reset_at }, weekly: {...} }
 *   3. { remaining_5h, total_5h, remaining_weekly, total_weekly, reset_at_5h, ... }
 *
 * Any other shape becomes "error" with the field names we saw, so the user
 * can report exactly what's there.
 */

import type { QuotaAdapter, QuotaAdapterContext } from "./base.ts"
import { safeFetch, statusFromHttp, pickCredential, pctToRatio, epochMsToIso, formatRemainMs } from "./base.ts"
import type { ProviderCapabilities, QuotaSnapshot, QuotaWindow } from "../../shared/types.ts"
import { isObject, parseMoneyOrUndefined, requireObject, clampRatio, asString, isFiniteNumber } from "../../shared/schemas.ts"

export interface MiniMaxAdapterOptions {
  /** Registry identity; allows CN and international routes to stay distinct. */
  id?: string
  displayName?: string
  /** International endpoint (overridable for tests). */
  intlEndpoint?: string
  /** China endpoint (overridable for tests). */
  cnEndpoint?: string
  /**
    * Region the route resolver declared. "cn" picks the China endpoint;
    * anything else uses international.
    */
  region?: "cn" | "intl"
  /** Plan tier labels we know about; falls back to "Token Plan". */
  tierLabels?: Record<string, string>
  /**
    * Logged-in web session cookie for the coding_plan endpoint. MiniMax
    * refuses pure Bearer auth on this API; supplying the cookie unlocks
    * the same HTML session the user sees in their browser.
    */
  cookie?: string
  warningRemainingBelow?: number
}

const DEFAULT_INTL = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains"
const DEFAULT_CN = "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains"

const API_KEY_REFS = ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MINIMAX_INTL_API_KEY"] as const
const COOKIE_REFS = ["MINIMAX_COOKIE", "MINIMAX_CN_COOKIE", "MINIMAX_INTL_COOKIE", "MINIMAX_SESSION_COOKIE"] as const

function makeDebugInfo(endpoint: string, credRef: string): string {
  return `endpoint: ${endpoint.replace(/^https?:\/\//, "")} · credential: ${credRef}`
}

export function createMiniMaxAdapter(opts: MiniMaxAdapterOptions = {}): QuotaAdapter {
  const providerId = opts.id ?? "minimax-intl"
  const displayName = opts.displayName ?? (opts.region === "cn" ? "MiniMax China" : "MiniMax Global")
  const intlEndpoint = opts.intlEndpoint ?? DEFAULT_INTL
  const cnEndpoint = opts.cnEndpoint ?? DEFAULT_CN
  const tierLabels = opts.tierLabels ?? {
    default: "Token Plan",
    pro: "Pro",
    ultra: "Ultra",
    max: "Max",
  }

  return {
    id: providerId,
    displayName,
    credentialRefs: [...API_KEY_REFS, ...COOKIE_REFS],
    supported: true,

    async fetch(ctx: QuotaAdapterContext): Promise<QuotaSnapshot> {
      const fetchedAt = new Date().toISOString()
      const capabilities: ProviderCapabilities = { balance: false, quota: true, usage: true }

      // Region hint biases the credential pick order: a CN route prefers a CN key.
      const refOrder = credentialOrderForRegion(opts.region)

      const cred = await pickCredential(refOrder, ctx)
      const cookie = opts.cookie ?? (await pickCredential(cookieOrderForRegion(opts.region), ctx))?.value
      if (cred === undefined && cookie === undefined) {
        return {
          providerId,
          providerDisplayName: displayName,
          status: "not-configured",
          message: `No MiniMax API key or session cookie configured · ${opts.region ?? "intl"}`,
          fetchedAt,
          capabilities,
        }
      }

      const primary = opts.region === "cn" ? cnEndpoint : intlEndpoint

      function originOf(url: string): string {
        try { const u = new URL(url); return u.protocol + "//" + u.host } catch { return "" }
      }
      const primaryOrigin = originOf(primary)

      type FetchAttempt = { ok: true; response: Awaited<ReturnType<typeof safeFetch>>; endpoint: string } | { ok: false; err?: Error; status?: number; endpoint: string; body?: unknown }
      async function tryEndpoint(url: string, token: string, origin: string, sessionCookie: string | undefined): Promise<FetchAttempt> {
        let res
        try {
          res = await safeFetch({
            url,
            method: "GET",
            headers: {
              ...(sessionCookie !== undefined && sessionCookie.length > 0 ? { cookie: sessionCookie } : { authorization: `Bearer ${token}` }),
              "content-type": "application/json",
              "accept": "application/json, text/plain, */*",
              "x-requested-with": "XMLHttpRequest",
              "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
              "accept-language": "en-US,en;q=0.9",
              ...(origin.length > 0 ? { origin, referer: origin } : {}),
            },
            timeoutMs: 8_000,
            signal: ctx.signal,
          })
        } catch (err) {
          return { ok: false, err: err instanceof Error ? err : new Error(String(err)), endpoint: url }
        }
        return { ok: true, response: res, endpoint: url }
      }

      const attempt = await tryEndpoint(primary, cred?.value ?? "", primaryOrigin, cookie)

      if (!attempt.ok) {
        return {
          providerId,
          providerDisplayName: displayName,
          status: "network-error",
          message: `${attempt.err?.message ?? "network error"} · ${makeDebugInfo(attempt.endpoint, cookie !== undefined ? "session" : cred?.ref ?? "credential")}`,
          fetchedAt,
          capabilities,
        }
      }

      const response = attempt.response
      const endpoint = attempt.endpoint
      if (response.status === 401 || response.status === 403) {
        return {
          providerId,
          providerDisplayName: displayName,
          status: "auth-error",
          message: `Authentication failed via ${cookie !== undefined ? "session cookie" : cred?.ref ?? "credential"}`,
          fetchedAt,
          capabilities,
        }
      }
      if (response.status === 429) {
        return {
          providerId,
          providerDisplayName: displayName,
          status: "rate-limited",
          message: `MiniMax rate-limited; retrying later · ${makeDebugInfo(endpoint, "—")}`,
          fetchedAt,
          capabilities,
        }
      }
      if (response.status === 404) {
        return {
          providerId,
          providerDisplayName: displayName,
          status: "unsupported",
          message: `Endpoint not available at ${endpoint} (${opts.region ?? "intl"}) — Token Plan endpoint may have moved. · ${makeDebugInfo(endpoint, "—")}`,
          fetchedAt,
          capabilities,
        }
      }
      if (!response.ok) {
        return {
          providerId,
          providerDisplayName: displayName,
          status: statusFromHttp(response.status),
          message: `HTTP ${response.status} · ${makeDebugInfo(endpoint, "—")}`,
          fetchedAt,
          capabilities,
        }
      }

      let body: unknown
      try {
        body = JSON.parse(response.text)
      } catch {
        return {
          providerId,
          providerDisplayName: displayName,
          status: "error",
          message: `Malformed JSON response · ${makeDebugInfo(endpoint, "—")}`,
          fetchedAt,
          capabilities,
        }
      }
      if (!isObject(body)) {
        return {
          providerId,
          providerDisplayName: displayName,
          status: "error",
          message: `Response is not a JSON object · ${makeDebugInfo(endpoint, "—")}`,
          fetchedAt,
          capabilities,
        }
      }
      const normalized = normalizeMiniMaxResponse(body, tierLabels)
      if ("error" in normalized) {
        return {
          providerId,
          providerDisplayName: displayName,
          status: normalized.error === "unsupported" ? "unsupported" : normalized.error === "auth" ? "auth-error" : "error",
          message: `${normalized.message} · ${makeDebugInfo(endpoint, cookie !== undefined ? "session" : cred?.ref ?? "credential")}`,
          fetchedAt,
          capabilities,
        }
      }

      const quotas = normalized.quotas
      const modelNames = "modelNames" in normalized ? normalized.modelNames : undefined
      const debugInfo = `endpoint: ${endpoint.replace(/^https?:\/\//, "")} · auth: ${cookie !== undefined ? "session" : cred?.ref ?? "credential"}`
      let status: QuotaSnapshot["status"] = "ok"
      for (const q of quotas) {
        const r = q.remainingRatio
        if (r !== undefined && r <= 0.05) {
          status = "exhausted"
          break
        }
        if (r !== undefined && r <= (opts.warningRemainingBelow ?? 0.2) && status === "ok") {
          status = "warning"
        }
      }
      const messageParts: string[] = []
      if (modelNames !== undefined && modelNames.length > 0) {
        messageParts.push(`Models: ${modelNames.join(", ")}`)
      }
      messageParts.push(debugInfo)
      const message = messageParts.join(" · ")
      return {
        providerId,
        providerDisplayName: displayName,
        status,
        message,
        quotas,
        fetchedAt,
        capabilities,
      }
    },
  }
}

function credentialOrderForRegion(region: "cn" | "intl" | undefined): readonly string[] {
  if (region === "cn") {
    return ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY", "MINIMAX_INTL_API_KEY"]
  }
  if (region === "intl") {
    return ["MINIMAX_INTL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"]
  }
  return ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MINIMAX_INTL_API_KEY"]
}

function cookieOrderForRegion(region: "cn" | "intl" | undefined): readonly string[] {
  if (region === "cn") return ["MINIMAX_CN_COOKIE", "MINIMAX_COOKIE", "MINIMAX_SESSION_COOKIE", "MINIMAX_INTL_COOKIE"]
  return ["MINIMAX_INTL_COOKIE", "MINIMAX_COOKIE", "MINIMAX_SESSION_COOKIE", "MINIMAX_CN_COOKIE"]
}

type Normalized =
  | { quotas: QuotaWindow[]; tier?: string; modelNames?: string[] }
  | { error: "unsupported" | "schema" | "auth"; message: string }

interface TierLabels {
  default?: string
  pro?: string
  ultra?: string
  max?: string
  [key: string]: string | undefined
}

interface ApiModelRemain {
  start_time?: number
  end_time?: number
  remains_time?: number
  current_interval_total_count?: number
  current_interval_usage_count?: number
  model_name?: string
  current_weekly_total_count?: number
  current_weekly_usage_count?: number
  weekly_start_time?: number
  weekly_end_time?: number
  weekly_remains_time?: number
  current_interval_status?: number
  current_interval_remaining_percent?: number
  current_weekly_status?: number
  current_weekly_remaining_percent?: number
  weekly_boost_permille?: number
}

interface ApiBaseResp {
  status_code?: number
  status_msg?: string
}

function decodeStatusMsg(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  return raw.replace(/\\u([0-9A-Fa-f]{4})/g, (_match, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
}

function normalizeMiniMaxResponse(body: Record<string, unknown>, tierLabels: TierLabels): Normalized {
  // Variant 4 (current MiniMax API): { base_resp, model_remains: [...] }
  if ("base_resp" in body) {
    const baseResp = body["base_resp"] as ApiBaseResp | undefined
    const code = baseResp?.status_code
    if (isFiniteNumber(code) && code !== 0) {
      const msg = decodeStatusMsg(asString(baseResp?.status_msg))
      // 1004 / 1008 / similar are auth; everything else non-zero is generic error.
      const isAuth = code === 1004 || code === 1008 || code === 10013 || code === 10014
      return {
        error: isAuth ? "auth" : "schema",
        message: msg ?? `MiniMax returned base_resp status_code=${code}`,
      }
    }
    const modelRemainsRaw = body["model_remains"]
    if (Array.isArray(modelRemainsRaw) && modelRemainsRaw.length > 0) {
      const modelRemains: ApiModelRemain[] = modelRemainsRaw.filter(isObject) as ApiModelRemain[]
      const quotas = modelRemains.flatMap((m) => modelRemainToQuotas(m))
      const modelNames = modelRemains
        .map((m) => asString(m.model_name))
        .filter((s): s is string => s !== undefined)
      if (quotas.length === 0) {
        return { error: "schema", message: "model_remains has no recognizable window data" }
      }
      return { quotas, modelNames }
    }
    return {
      error: "schema",
      message: decodeStatusMsg(asString(baseResp?.status_msg)) ?? "model_remains missing",
    }
  }

  // Variant 1: { code, message, data: { "5h": {...}, weekly: {...}, plan_tier } }
  const code = body["code"]
  if (isFiniteNumber(code) && "data" in body) {
    if (code !== 0 && code !== 200) {
      return { error: "unsupported", message: `MiniMax Token Plan returned code ${code}` }
    }
    const data = body["data"]
    if (!isObject(data)) return { error: "schema", message: "data is not an object" }
    const tier = asString(data["plan_tier"])
    return { quotas: extractWindowsFromData(data, tierLabels, tier), tier }
  }

  // Variant 2: { "5-hour": {...}, weekly: {...}, reset_at: ..., plan_tier: ... }
  if ("5-hour" in body || "5h" in body || "weekly" in body) {
    const tier = asString(body["plan_tier"])
    return { quotas: extractWindowsFromData(body, tierLabels, tier), tier }
  }

  // Variant 3: flat fields like remaining_5h / total_5h / reset_at_5h / etc.
  if (
    "remaining_5h" in body ||
    "remaining_weekly" in body ||
    "usage_5h" in body
  ) {
    return { quotas: extractFlatWindows(body, tierLabels), tier: asString(body["plan_tier"]) }
  }

  return {
    error: "unsupported",
    message: `Unknown MiniMax Token Plan response shape (keys: ${Object.keys(body).join(", ")})`,
  }
}

function modelRemainToQuotas(m: ApiModelRemain): QuotaWindow[] {
  const out: QuotaWindow[] = []
  const modelLabel = asString(m.model_name) ?? "model"
  const weeklyBoost = isFiniteNumber(m.weekly_boost_permille)
    ? m.weekly_boost_permille / 1000
    : 1

  const intervalPct = m.current_interval_remaining_percent
  const intervalTotal = m.current_interval_total_count
  const intervalUsed = m.current_interval_usage_count
  const intervalRemaining = intervalTotal !== undefined && intervalUsed !== undefined
    ? Math.max(0, intervalTotal - intervalUsed)
    : undefined
  const intervalRatio = pctToRatio(intervalPct)
  if (intervalRatio !== undefined || intervalRemaining !== undefined || intervalTotal !== undefined) {
    out.push({
      id: `${modelLabel}:5h`,
      label: `5h · ${modelLabel}`,
      remainingRatio: intervalRatio,
      remaining: intervalRemaining,
      total: intervalTotal,
      unit: "requests",
      resetAt: epochMsToIso(m.end_time),
    })
  }

  const weeklyPct = m.current_weekly_remaining_percent
  const weeklyTotal = m.current_weekly_total_count
  const weeklyUsed = m.current_weekly_usage_count
  const weeklyRemaining = weeklyTotal !== undefined && weeklyUsed !== undefined
    ? Math.max(0, weeklyTotal - weeklyUsed)
    : undefined
  const weeklyRatio = pctToRatio(weeklyPct)
  if (weeklyRatio !== undefined || weeklyRemaining !== undefined || weeklyTotal !== undefined) {
    out.push({
      id: `${modelLabel}:weekly`,
      label: weeklyBoost > 1 ? `Week · ${modelLabel} (${Math.round(weeklyBoost * 100)}%)` : `Week · ${modelLabel}`,
      remainingRatio: weeklyRatio,
      remaining: weeklyRemaining,
      total: weeklyTotal,
      unit: "requests",
      resetAt: epochMsToIso(m.weekly_end_time),
    })
  }

  return out
}


function extractWindowsFromData(
  obj: Record<string, unknown>,
  tierLabels: TierLabels,
  tier: string | undefined,
): QuotaWindow[] {
  const out: QuotaWindow[] = []
  const fiveHour = readWindow(obj["5h"] ?? obj["5-hour"] ?? obj["five_hour"], "5-hour rolling window")
  if (fiveHour !== undefined) out.push(fiveHour)
  const weekly = readWindow(obj["weekly"] ?? obj["week"] ?? obj["seven_day"], "Weekly window")
  if (weekly !== undefined) out.push(weekly)
  if (tier !== undefined) {
    const label = tierLabels[tier.toLowerCase()] ?? `Plan: ${tier}`
    out.unshift({
      id: "plan_tier",
      label,
      remainingRatio: 1,
    })
  }
  if (out.length === 0) return out
  return out
}

function extractFlatWindows(obj: Record<string, unknown>, tierLabels: TierLabels): QuotaWindow[] {
  const out: QuotaWindow[] = []
  const r5 = parseMoneyOrUndefined(obj["remaining_5h"])
  const t5 = parseMoneyOrUndefined(obj["total_5h"])
  if (r5 !== undefined && t5 !== undefined && t5 > 0) {
    out.push({
      id: "5h",
      label: "5-hour rolling window",
      remaining: r5,
      total: t5,
      unit: "requests",
      remainingRatio: clampRatio(r5 / t5),
      resetAt: asString(obj["reset_at_5h"]),
    })
  } else {
    const used5 = parseMoneyOrUndefined(obj["usage_5h"])
    const lim5 = parseMoneyOrUndefined(obj["limit_5h"])
    if (used5 !== undefined && lim5 !== undefined && lim5 > 0) {
      out.push({
        id: "5h",
        label: "5-hour rolling window",
        remaining: Math.max(0, lim5 - used5),
        total: lim5,
        unit: "requests",
        remainingRatio: clampRatio(1 - used5 / lim5),
        resetAt: asString(obj["reset_at_5h"]),
      })
    }
  }
  const rw = parseMoneyOrUndefined(obj["remaining_weekly"])
  const tw = parseMoneyOrUndefined(obj["total_weekly"])
  if (rw !== undefined && tw !== undefined && tw > 0) {
    out.push({
      id: "weekly",
      label: "Weekly window",
      remaining: rw,
      total: tw,
      unit: "requests",
      remainingRatio: clampRatio(rw / tw),
      resetAt: asString(obj["reset_at_weekly"]),
    })
  }
  const tier = asString(obj["plan_tier"])
  if (tier !== undefined) {
    const label = tierLabels[tier.toLowerCase()] ?? `Plan: ${tier}`
    out.unshift({ id: "plan_tier", label, remainingRatio: 1 })
  }
  return out
}

function readWindow(v: unknown, label: string): QuotaWindow | undefined {
  if (!isObject(v)) return undefined
  const remaining = parseMoneyOrUndefined(v["remaining"]) ?? parseMoneyOrUndefined(v["remaining_count"])
  const total = parseMoneyOrUndefined(v["total"]) ?? parseMoneyOrUndefined(v["limit"]) ?? parseMoneyOrUndefined(v["total_count"])
  const used = parseMoneyOrUndefined(v["usage"]) ?? parseMoneyOrUndefined(v["used"])
  const id = typeof v["id"] === "string" ? (v["id"] as string) : label.toLowerCase().includes("5") ? "5h" : "weekly"
  const ratio = clampRatio(
    remaining !== undefined && total !== undefined && total > 0
      ? remaining / total
      : used !== undefined && total !== undefined && total > 0
        ? 1 - used / total
        : undefined,
  )
  if (ratio === undefined && remaining === undefined && total === undefined) return undefined
  return {
    id,
    label,
    remainingRatio: ratio,
    remaining,
    total,
    unit: asString(v["unit"]) ?? "tokens",
    resetAt: asString(v["reset_at"]) ?? asString(v["next_reset_at"]),
  }
}
