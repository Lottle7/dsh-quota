/**
 * Route Resolver — maps the current DSH ModelSelection to a billing provider.
 *
 * Resolution order (highest priority first):
 *   1. Explicit routeMappings (user-supplied, e.g. "my-relay" → "deepseek-official").
 *   2. Exact registry alias (for example `minimax-cn` and `minimax-global`
 *      resolve to distinct regional billing accounts).
 *   3. Heuristic — when the model string carries a known vendor prefix
 *      (e.g. "minimax/...") we keep the route provider as the billing
 *      authority and only classify the model vendor separately. The billing
 *      provider is NEVER derived from the model name (that would be the
 *      classic MiniMax-on-OpenRouter bug).
 *   4. Unknown — leave it to the UI to ask the user.
 *
 * The model vendor classifier is independent: it inspects the model string
 * to tag the snapshot, but never changes who charges the user.
 */

import type { ProviderId, ResolvedBillingRoute } from "../shared/types.ts"

export interface ModelSelectionLike {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ResolverContext {
  /** Provider-id → registered record (id, displayName, routeAliases, modelVendors). */
  registry: ReadonlyMap<ProviderId, RegisteredProvider>
  /** User-supplied explicit mappings (provider → billing provider id). */
  explicitMappings: Readonly<Record<string, string>>
}

export interface RegisteredProvider {
  id: ProviderId
  displayName: string
  /** Lowercased route aliases this provider owns (e.g. "minimax-cn"). */
  routeAliases: readonly string[]
  /** Lowercased model vendor prefixes (e.g. "minimax"). */
  modelVendors: readonly string[]
}

const VENDOR_SEPARATORS = ["/", "-", "_", ":"]

/**
 * Extract a model-vendor hint from the model id, for tagging only.
 * Returns undefined when no known vendor matches.
 */
export function classifyModelVendor(
  model: string,
  registry: ReadonlyMap<ProviderId, RegisteredProvider>,
): string | undefined {
  const lower = model.toLowerCase()
  for (const entry of registry.values()) {
    for (const vendor of entry.modelVendors) {
      const v = vendor.toLowerCase()
      if (lower === v) return v
      for (const sep of VENDOR_SEPARATORS) {
        if (lower.startsWith(v + sep)) return v
      }
    }
  }
  return undefined
}

/**
 * Resolve a ModelSelection into a ResolvedBillingRoute.
 *
 * The returned object always has a confidence level so the UI can explain
 * why it picked the provider. "unknown" routes must NOT be used to charge the
 * user — the client UI shows an explanatory hint instead.
 */
export function resolveBillingRoute(
  selection: ModelSelectionLike,
  ctx: ResolverContext,
): ResolvedBillingRoute {
  const provider = selection.provider.toLowerCase()
  const model = selection.model

  // 1. Explicit mapping wins.
  const explicit = ctx.explicitMappings[provider]
  if (explicit !== undefined && ctx.registry.has(explicit)) {
    return {
      routeProvider: selection.provider,
      billingProviderId: explicit,
      modelVendor: classifyModelVendor(model, ctx.registry),
      model,
      confidence: "mapped",
    }
  }

  // 2. Registry alias exact match.
  for (const entry of ctx.registry.values()) {
    if (entry.routeAliases.includes(provider)) {
      return {
        routeProvider: selection.provider,
        billingProviderId: entry.id,
        modelVendor: classifyModelVendor(model, ctx.registry),
        model,
        confidence: "exact",
      }
    }
  }

  // 3. Heuristic — billing stays with the route provider; only the vendor
  // is classified separately. We still need a billingProviderId even when
  // we don't know it, so the UI can fall back to "unknown" messaging.
  const vendor = classifyModelVendor(model, ctx.registry)
  const heuristicMatch = findHeuristicProvider(provider, ctx.registry)
  if (heuristicMatch !== undefined) {
    return {
      routeProvider: selection.provider,
      billingProviderId: heuristicMatch,
      modelVendor: vendor,
      model,
      confidence: "heuristic",
    }
  }

  return {
    routeProvider: selection.provider,
    billingProviderId: "unknown",
    modelVendor: vendor,
    model,
    confidence: "unknown",
  }
}

/**
 * Pick a billing provider when the route provider string itself resembles
 * a known provider id (e.g. "openrouter" or a 3rd-party "openrouter-relay").
 * Conservative — only triggers when no other alias matched.
 */
function findHeuristicProvider(
  provider: string,
  registry: ReadonlyMap<ProviderId, RegisteredProvider>,
): ProviderId | undefined {
  const lower = provider.toLowerCase()
  for (const entry of registry.values()) {
    for (const alias of entry.routeAliases) {
      if (lower === alias || lower.startsWith(alias + "-")) {
        return entry.id
      }
    }
  }
  return undefined
}

/**
 * Build a synthetic unsupported snapshot for "unknown" providers so the UI
 * can keep its layout stable instead of crashing.
 */
export function unsupportedSnapshot(
  route: ResolvedBillingRoute,
  fetchedAt: string,
): import("../shared/types.ts").QuotaSnapshot {
  return {
    providerId: route.billingProviderId,
    providerDisplayName: route.billingProviderId === "unknown" ? "Unknown provider" : route.billingProviderId,
    routeProvider: route.routeProvider,
    modelVendor: route.modelVendor,
    model: route.model,
    status: route.billingProviderId === "unknown" ? "unsupported" : "not-configured",
    message: route.billingProviderId === "unknown"
      ? `No adapter registered for route "${route.routeProvider}". Map it in settings.dsh-quota.routeMappings.`
      : `Provider ${route.billingProviderId} has no configured adapter.`,
    fetchedAt,
    capabilities: { balance: false, quota: false },
  }
}
