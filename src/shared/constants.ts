/**
 * Stable identifiers and limits used across adapters, caching and polling.
 *
 * Plugin-wide constants live here so adapters can stay declarative; do NOT
 * put per-adapter behavior into this file — those belong next to the adapter
 * that owns them.
 */

/** Plugin id used in logs, settings namespace, and cordis row id. */
export const PLUGIN_ID = "dsh-quota"

/** Settings namespace owned by this plugin (lowercase kebab-case). */
export const SETTINGS_NAMESPACE = "dsh-quota"

/** Default refresh cadence for the auto-following indicator (60s). */
export const DEFAULT_REFRESH_INTERVAL_MS = 60_000

/** Minimum refresh interval we'll honor (15s — protects provider APIs). */
export const MIN_REFRESH_INTERVAL_MS = 15_000

/** Maximum refresh interval (24h — for users who want to disable auto-refresh). */
export const MAX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

/** HTTP timeout applied to every quota API call. */
export const REQUEST_TIMEOUT_MS = 12_000

/** Maximum response body bytes (defensive; most responses are <32 KB). */
export const MAX_RESPONSE_BYTES = 256 * 1024

/** Backoff ladder applied to consecutive error refreshes. */
export const ERROR_BACKOFF_MS = [60_000, 120_000, 300_000] as const

/** Secret-marker used by the redact helper to confirm a snapshot is clean. */
export const REDACTED_MARKER = "[redacted]"
