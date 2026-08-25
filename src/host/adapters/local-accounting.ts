/** Provider adapter for routes that support local Token/cost attribution only. */

import type { QuotaAdapter } from "./base.ts"

export interface LocalAccountingAdapterOptions {
  id: string
  displayName: string
}

export function createLocalAccountingAdapter(options: LocalAccountingAdapterOptions): QuotaAdapter {
  return {
    id: options.id,
    displayName: options.displayName,
    credentialRefs: [],
    supported: true,
    async fetch(ctx) {
      return {
        providerId: ctx.providerId,
        providerDisplayName: options.displayName,
        status: "ok",
        message: "Local Token and price accounting is active; no provider account API is queried.",
        fetchedAt: new Date().toISOString(),
        capabilities: { balance: false, quota: false, usage: false, localAccounting: true },
      }
    },
  }
}
