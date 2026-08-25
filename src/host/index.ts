/** Host half: provider registry, normalized quota service and browser routes. */

import type { IncomingMessage } from "node:http"
import type { Context } from "@deepseek-ai/cordis"
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings"
import z from "@deepseek-ai/schemastery"
import { ProviderRegistry, type ProviderRecord } from "./provider-registry.ts"
import { QuotaService, type CredentialsServiceLike } from "./quota-service.ts"
import { makeQuotaRoutes, type QuotaSettingsSnapshot } from "./routes.ts"
import { resolveBillingRoute } from "./route-resolver.ts"
import {
  HostUsageLedger,
  type SessionEventLike,
  type SessionLike,
  type SessionPersistenceLike,
  type SessionStoreLike,
  type StorageDomainLike,
} from "./usage-ledger.ts"
import { createDeepSeekAdapter } from "./adapters/deepseek.ts"
import { createMiniMaxAdapter } from "./adapters/minimax.ts"
import { createOpenRouterAdapter } from "./adapters/openrouter.ts"
import { createSiliconFlowAdapter } from "./adapters/siliconflow.ts"
import { createLocalAccountingAdapter } from "./adapters/local-accounting.ts"
import {
  DEFAULT_REFRESH_INTERVAL_MS,
  MAX_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  PLUGIN_ID,
  SETTINGS_NAMESPACE,
} from "../shared/constants.ts"

export const name = PLUGIN_ID
export const inject = ["webServer", "settings", "credentials", "storageDomain", "sessionPersistence", "sessions"] as const

export interface Config {
  enabled?: boolean
  refreshIntervalMs?: number
  warningBalanceBelow?: number
  warningQuotaRemainingBelow?: number
  routeMappings?: Record<string, string>
  providerEnabled?: Record<string, boolean>
  /** Non-loopback browser authorities allowed to call the exact plugin routes. */
  trustedHosts?: string[]
  /** Number of days retained by the Host usage ledger. */
  usageRetentionDays?: number
  pricing?: import("../shared/usage.ts").PricingTable
}

const PRICE_SET_SCHEMA = z.object({
  inputCacheHitPerMTokCNY: z.number().min(0).default(0),
  inputCacheMissPerMTokCNY: z.number().min(0).default(0),
  outputPerMTokCNY: z.number().min(0).default(0),
})

const _ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  refreshIntervalMs: z.number().min(MIN_REFRESH_INTERVAL_MS).max(MAX_REFRESH_INTERVAL_MS).default(DEFAULT_REFRESH_INTERVAL_MS),
  warningBalanceBelow: z.number().min(0).default(10),
  warningQuotaRemainingBelow: z.number().min(0).max(1).default(0.2),
  routeMappings: z.dict(z.string()).default({}),
  providerEnabled: z.dict(z.boolean()).default({}),
  trustedHosts: z.array(z.string()).default([]),
  usageRetentionDays: z.number().min(30).max(3650).default(90),
  pricing: z.object({
    default: PRICE_SET_SCHEMA,
    overrides: z.dict(PRICE_SET_SCHEMA).default({}),
    peakHours: z.object({
      weekdays: z.array(z.union(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).default([]),
      windows: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
      timezone: z.string().default("Asia/Shanghai"),
    }),
  }).default({
    default: { inputCacheHitPerMTokCNY: 0, inputCacheMissPerMTokCNY: 0, outputPerMTokCNY: 0 },
    overrides: {},
    peakHours: { weekdays: [], windows: [], timezone: "Asia/Shanghai" },
  }),
})

export const Config = _ConfigSchema as unknown as z<Config>

export async function apply(ctx: Context, config?: Config): Promise<void> {
  const host = ctx as Context & {
    credentials: CredentialsServiceLike
    webServer: { register(route: unknown): () => void }
    storageDomain: StorageDomainLike
    sessionPersistence: SessionPersistenceLike
    sessions: SessionStoreLike
    logger?: { warn(message: string): void }
  }
  let source: () => Config = () => config ?? {}
  const resolve = (): Required<Omit<Config, "pricing">> & Pick<Config, "pricing"> => ({
    enabled: source().enabled ?? true,
    refreshIntervalMs: source().refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    warningBalanceBelow: source().warningBalanceBelow ?? 10,
    warningQuotaRemainingBelow: source().warningQuotaRemainingBelow ?? 0.2,
    routeMappings: source().routeMappings ?? {},
    providerEnabled: source().providerEnabled ?? {},
    trustedHosts: source().trustedHosts ?? [],
    usageRetentionDays: source().usageRetentionDays ?? 90,
    pricing: source().pricing,
  })

  const registry = new ProviderRegistry()
  for (const provider of builtInProviders()) registry.register({ ...provider, enabled: true })
  const applyFlags = (): void => {
    const flags = resolve().providerEnabled
    for (const id of registry.ids()) {
      const record = registry.get(id)
      if (record !== undefined) record.enabled = flags[id] ?? true
    }
  }
  applyFlags()

  const service = new QuotaService(registry, host.credentials, {
    cacheTtlMs: () => resolve().refreshIntervalMs,
    thresholds: () => ({
      warningBalanceBelow: resolve().warningBalanceBelow,
      warningQuotaRemainingBelow: resolve().warningQuotaRemainingBelow,
    }),
  })

  let settingsSnapshot = snapshot(resolve())
  installSettingsSection(ctx, settingsNamespace(SETTINGS_NAMESPACE), Config, config ?? {}, {
    setSource: (nextSource: () => Config) => {
      source = nextSource
      settingsSnapshot = snapshot(resolve())
      applyFlags()
      service.invalidate()
    },
    onChange: () => {
      settingsSnapshot = snapshot(resolve())
      applyFlags()
      service.invalidate()
    },
  })

  const usageLedger = await HostUsageLedger.open({
    storageDomain: host.storageDomain,
    sessionPersistence: host.sessionPersistence,
    sessions: host.sessions,
    retainedDays: resolve().usageRetentionDays,
    logger: host.logger,
    resolveBillingProvider: (provider, model) => resolveBillingRoute(
      { provider, model },
      { registry: registry.asResolverView(), explicitMappings: resolve().routeMappings },
    ).billingProviderId,
  })
  ctx.effect(() => () => usageLedger.close(), `${PLUGIN_ID}: usage-ledger`)

  const { routes } = makeQuotaRoutes({
    registry,
    service,
    isEnabled: () => resolve().enabled,
    isTrustedRequest: (request) => isTrustedBrowserRequest(request, resolve().trustedHosts),
    getSettings: () => settingsSnapshot,
    usageLedger,
  })
  ctx.effect(() => {
    const disposers = routes.map((route) => host.webServer.register(route))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, `${PLUGIN_ID}: routes`)

  const offCredentials = (ctx.on as (event: string, listener: () => void) => () => void)("credentials/updated", () => {
    service.invalidate()
  })
  ctx.effect(() => () => offCredentials?.(), `${PLUGIN_ID}: credential-cache`)

  const offSessionEvents = (ctx.on as (
    event: string,
    listener: (session: SessionLike, event: SessionEventLike) => void,
  ) => () => void)("session/event", (session, event) => usageLedger.observeLive(session, event))
  ctx.effect(() => () => offSessionEvents?.(), `${PLUGIN_ID}: usage-events`)
  void usageLedger.startBackfill()
}

function builtInProviders(): Array<Omit<ProviderRecord, "enabled">> {
  const minimaxCn = createMiniMaxAdapter({
    id: "minimax-cn",
    displayName: "MiniMax China",
    region: "cn",
  })
  const minimaxIntl = createMiniMaxAdapter({
    id: "minimax-intl",
    displayName: "MiniMax Global",
    region: "intl",
  })
  const deepseek = createDeepSeekAdapter({ warningBelow: 0 })
  const openrouter = createOpenRouterAdapter()
  const siliconflow = createSiliconFlowAdapter()
  const localAccounting = [
    {
      id: "moonshot",
      displayName: "Moonshot / Kimi",
      description: "Local Token and price accounting",
      region: "CN",
      website: "https://platform.kimi.com",
      brandColor: "#111827",
      routeAliases: ["moonshot", "moonshot-cn", "kimi", "kimi-api"],
    },
    {
      id: "zhipu",
      displayName: "Zhipu GLM",
      description: "Local Token and price accounting",
      region: "CN",
      website: "https://open.bigmodel.cn",
      brandColor: "#2563eb",
      routeAliases: ["zhipu", "bigmodel", "glm", "zhipu-coding"],
    },
    {
      id: "alibaba-bailian",
      displayName: "Alibaba Bailian",
      description: "Local Token and price accounting",
      region: "CN",
      website: "https://bailian.console.aliyun.com",
      brandColor: "#ff6a00",
      routeAliases: ["dashscope", "bailian", "alibaba", "aliyun-bailian"],
    },
    {
      id: "volcengine-ark",
      displayName: "Volcengine Ark",
      description: "Local Token and price accounting",
      region: "CN",
      website: "https://www.volcengine.com/product/ark",
      brandColor: "#1664ff",
      routeAliases: ["volcengine", "volcengine-ark", "ark", "doubao", "byteplus"],
    },
    {
      id: "together",
      displayName: "Together AI",
      description: "Local Token and price accounting",
      region: "Global",
      website: "https://www.together.ai",
      brandColor: "#ef4444",
      routeAliases: ["together", "together-ai"],
    },
    {
      id: "fireworks",
      displayName: "Fireworks AI",
      description: "Local Token and price accounting",
      region: "Global",
      website: "https://fireworks.ai",
      brandColor: "#f97316",
      routeAliases: ["fireworks", "fireworks-ai"],
    },
  ].map((entry): Omit<ProviderRecord, "enabled"> => {
    const adapter = createLocalAccountingAdapter(entry)
    return {
      ...entry,
      capabilities: { balance: false, quota: false, usage: false, localAccounting: true },
      modelVendors: [],
      credentialRefs: adapter.credentialRefs,
      adapter,
    }
  })
  return [
    {
      id: minimaxCn.id,
      displayName: minimaxCn.displayName,
      description: "Coding Plan 5-hour and weekly request windows",
      region: "CN",
      website: "https://www.minimaxi.com",
      brandColor: "#7c3aed",
      capabilities: { balance: false, quota: true, usage: true },
      routeAliases: ["minimax", "minimax-cn", "minimaxi", "minimax-official"],
      modelVendors: ["minimax"],
      credentialRefs: minimaxCn.credentialRefs,
      adapter: minimaxCn,
    },
    {
      id: minimaxIntl.id,
      displayName: minimaxIntl.displayName,
      description: "Global Coding Plan request windows",
      region: "Global",
      website: "https://www.minimax.io",
      brandColor: "#8b5cf6",
      capabilities: { balance: false, quota: true, usage: true },
      routeAliases: ["minimax-intl", "minimax-global", "minimax-io"],
      modelVendors: ["minimax"],
      credentialRefs: minimaxIntl.credentialRefs,
      adapter: minimaxIntl,
    },
    {
      id: deepseek.id,
      displayName: deepseek.displayName,
      description: "Official multi-currency account balance",
      region: "Global",
      website: "https://platform.deepseek.com",
      brandColor: "#4d6bfe",
      capabilities: { balance: true, quota: false, usage: false },
      routeAliases: ["deepseek", "deepseek-official", "deepseek-cn", "deepseek-intl"],
      modelVendors: ["deepseek"],
      credentialRefs: deepseek.credentialRefs,
      adapter: deepseek,
    },
    {
      id: openrouter.id,
      displayName: openrouter.displayName,
      description: "Current key spend, limit and reset cadence",
      region: "Global",
      website: "https://openrouter.ai",
      brandColor: "#111827",
      capabilities: { balance: true, quota: true, usage: true },
      routeAliases: ["openrouter", "open-router"],
      modelVendors: ["openrouter"],
      credentialRefs: openrouter.credentialRefs,
      adapter: openrouter,
    },
    {
      id: siliconflow.id,
      displayName: siliconflow.displayName,
      description: "Recharge, gift and total account balance",
      region: "CN",
      website: "https://cloud.siliconflow.cn",
      brandColor: "#0f766e",
      capabilities: { balance: true, quota: false, usage: false },
      routeAliases: ["siliconflow", "silicon-flow", "siliconcloud"],
      modelVendors: ["siliconflow", "deepseek", "qwen", "moonshot", "minimax"],
      credentialRefs: siliconflow.credentialRefs,
      adapter: siliconflow,
    },
    ...localAccounting,
  ]
}

function snapshot(config: ReturnType<typeof resolveConfigShape>): QuotaSettingsSnapshot {
  return {
    refreshIntervalMs: config.refreshIntervalMs,
    warningBalanceBelow: config.warningBalanceBelow,
    warningQuotaRemainingBelow: config.warningQuotaRemainingBelow,
    routeMappings: config.routeMappings,
    providerEnabled: config.providerEnabled,
    pricing: config.pricing,
  }
}

/** Type-only helper for snapshot() without leaking the closure-local resolve function. */
function resolveConfigShape(config: Config): Required<Omit<Config, "pricing">> & Pick<Config, "pricing"> {
  return {
    enabled: config.enabled ?? true,
    refreshIntervalMs: config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    warningBalanceBelow: config.warningBalanceBelow ?? 10,
    warningQuotaRemainingBelow: config.warningQuotaRemainingBelow ?? 0.2,
    routeMappings: config.routeMappings ?? {},
    providerEnabled: config.providerEnabled ?? {},
    trustedHosts: config.trustedHosts ?? [],
    usageRetentionDays: config.usageRetentionDays ?? 90,
    pricing: config.pricing,
  }
}

export function isTrustedBrowserRequest(request: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = firstHeader(request.headers.host)
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopback(hostUrl.hostname) && !trustedHosts.some((entry) => authorityMatches(hostUrl, entry))) return false
  if (firstHeader(request.headers["sec-fetch-site"])?.toLowerCase() === "cross-site") return false
  const origin = firstHeader(request.headers.origin)
  if (origin === undefined) return true
  try { return new URL(origin).host.toLowerCase() === hostUrl.host.toLowerCase() } catch { return false }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parseAuthority(authority: string): URL | undefined {
  if (authority.includes("/") || authority.includes("@") || authority.trim() !== authority) return undefined
  try {
    const parsed = new URL(`http://${authority}`)
    return parsed.hostname.length > 0 ? parsed : undefined
  } catch { return undefined }
}

function authorityMatches(host: URL, configured: string): boolean {
  const entry = parseAuthority(configured)
  if (entry === undefined) return false
  return entry.port.length > 0
    ? entry.host.toLowerCase() === host.host.toLowerCase()
    : entry.hostname.toLowerCase() === host.hostname.toLowerCase()
}

function isLoopback(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value)
}
