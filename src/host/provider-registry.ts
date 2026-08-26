/**
 * Provider Registry — the single source of truth for billing-provider
 * metadata and adapters. Avoids if/else forests in the rest of the code.
 *
 * Adding a new provider means: implement a QuotaAdapter, then call
 * register(). The rest of the plugin (route resolver, quota service,
 * HTTP routes and UI selector) picks it up automatically.
 */

import type {
  ProviderId,
  ProviderListItem,
  QuotaSnapshot,
} from "../shared/types.ts"
import type { QuotaAdapter, QuotaAdapterContext } from "./adapters/base.ts"
import type { RegisteredProvider } from "./route-resolver.ts"

export interface ProviderRecord extends RegisteredProvider {
  /** The adapter that produces a QuotaSnapshot for this provider. */
  adapter: QuotaAdapter
  /** Whether this provider is enabled in the user's settings (defaults true). */
  enabled: boolean
  /** Credential reference names the adapter may resolve through ctx.credentials. */
  credentialRefs: readonly string[]
  description?: string
  region?: string
  website?: string
  brandColor?: string
  capabilities?: import("../shared/types.ts").ProviderCapabilities
  custom?: boolean
}

export interface RegistryCredentialProbe {
  configured(ref: string): Promise<boolean>
}

export interface RegistryStatusLookup {
  status(id: ProviderId): QuotaSnapshot["status"] | undefined
}

export class ProviderRegistry {
  private readonly records = new Map<ProviderId, ProviderRecord>()
  private readonly order: ProviderId[] = []

  register(record: ProviderRecord): void {
    if (this.records.has(record.id)) {
      throw new Error(`Provider "${record.id}" is already registered`)
    }
    this.records.set(record.id, record)
    this.order.push(record.id)
  }

  /** Remove a provider and its stable list position. Used for live settings reloads. */
  unregister(id: ProviderId): boolean {
    const removed = this.records.delete(id)
    if (!removed) return false
    const index = this.order.indexOf(id)
    if (index >= 0) this.order.splice(index, 1)
    return true
  }

  has(id: ProviderId): boolean {
    return this.records.has(id)
  }

  get(id: ProviderId): ProviderRecord | undefined {
    return this.records.get(id)
  }

  /**
   * List all providers, with their config state. The browser uses this for
   * the manual selector; it never sees the credential value.
   */
  async list(probe: RegistryCredentialProbe, status?: RegistryStatusLookup): Promise<ProviderListItem[]> {
    const out: ProviderListItem[] = []
    for (const id of this.order) {
      const r = this.records.get(id)!
      // Local-accounting providers deliberately need no credential because
      // they only classify DSH's existing Token projection.
      let configured = r.credentialRefs.length === 0
      for (const ref of r.credentialRefs) {
        if (await probe.configured(ref)) {
          configured = true
          break
        }
      }
      out.push({
        id: r.id,
        displayName: r.displayName,
        description: r.description,
        region: r.region,
        website: r.website,
        brandColor: r.brandColor,
        capabilities: r.capabilities,
        custom: r.custom,
        configured,
        supported: r.enabled && r.adapter.supported,
        status: status?.status(r.id),
        canRefresh: r.enabled && r.adapter.supported && configured,
      })
    }
    return out
  }

  /** Read-only view used by the route resolver. */
  asResolverView(): ReadonlyMap<ProviderId, RegisteredProvider> {
    const view = new Map<ProviderId, RegisteredProvider>()
    for (const [id, r] of this.records) {
      if (!r.enabled) continue
      view.set(id, {
        id: r.id,
        displayName: r.displayName,
        routeAliases: r.routeAliases,
        modelVendors: r.modelVendors,
      })
    }
    return view
  }

  ids(): ProviderId[] {
    return [...this.order]
  }
}
