# Changelog

All notable changes to this project are documented in this file. The project
follows [Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-08-26

### Added

- Host-configurable custom providers for credential-free local Token/cost attribution.
- Hardened public HTTPS JSON adapters with Bearer, `X-API-Key`, or unauthenticated GET requests.
- Safe dot-path mappings for balance, usage, limit and remaining values, including currency and unit scaling.
- Automatic custom-provider cards, route aliases, model-vendor classification and live registry rebuilding.
- Generation-aware cache invalidation so an old in-flight request cannot overwrite a reconfigured provider.
- Live cache invalidation on DSH's canonical `credentials/reference-updated` event.

### Security

- Reject non-HTTPS, non-443, query-bearing, credential-bearing, private, loopback and reserved endpoints.
- Validate every DNS result and pin TLS connections to validated public addresses to prevent DNS rebinding.
- Refuse redirects and arbitrary headers, cap responses at 256 KiB, and keep endpoints, credential references and raw JSON out of browser payloads.

## [0.7.0] - 2026-08-26

### Added

- Browser-local daily and rolling 30-day CNY budgets with a configurable 50–100% warning threshold.
- Budget progress and warning states in Overview, Usage, the floating dashboard and the global panel notice area.
- Settings editor for enabling, changing or disabling budgets without touching Host configuration or provider bills.
- Safe budget metadata in diagnostics and summary JSON exports.

### Changed

- Usage aggregates now distinguish complete pricing from partially unpriced model usage.
- Budget evaluation reports missing prices instead of treating an incomplete zero/partial estimate as safe spend.
- Provider health remains visible while budget warnings can independently promote the floating dashboard to warning or exceeded state.

## [0.6.1] - 2026-08-25

### Added

- Cursor-based call history with bounded pages and a load-more flow.
- Provider, exact-model, source and free-text filters for the Host usage ledger.
- Full filtered CSV export with spreadsheet-formula injection protection.
- Complete Host-side daily/provider/model summary buckets returned independently of list pagination.

### Changed

- Dashboard totals, charts and breakdowns now use the complete Host aggregate instead of only the first page of call rows.
- Recent-call status shows visible versus total matching calls and reports sync/filter/export failures inline.

### Fixed

- Safe diagnostics now report the package version from a shared version constant.

## [0.6.0] - 2026-08-25

### Added

- Durable Host-side per-call usage ledger backed by DSH storage-domain.
- Revision-aware historical backfill through the official immutable Session inspection API.
- Sync status, manual history rescan and recent call-level usage details in the Usage tab.
- Configurable 30–3650 day Host retention (`usageRetentionDays`, default 90).
- Compatibility migration for pre-v0.6 browser aggregates that imports only history not covered by native Session logs.

### Changed

- Daily and rolling usage analytics now use the Host ledger as their source of truth; browser storage is a compatibility mirror.
- Current-conversation estimated cost now uses only the current Session Token projection instead of today's aggregate cost.

### Fixed

- Usage no longer remains at zero while DSH's native footer reports Tokens.
- Repeated streaming/final usage samples for the same turn and step no longer double-count.
- Numeric Token buckets bypass the credential sanitizer that would otherwise replace the `tokens` field with `[redacted]`.

## [0.5.1] - 2026-08-25

### Added

- English-first project page with a complete Chinese guide and search-oriented package metadata.
- Tagged-release workflow that publishes a prebuilt `dsh-quota.tgz` DSH Bundle.
- Git-source installation support through the standard `prepare` lifecycle.

### Changed

- Documented the official `dsh plugin --profile web` install, update and removal flow.
- Declared DSH Host packages as peers and exported the Bundle patch explicitly.
- Updated the official GitHub Actions to their current major versions.

## [0.5.0] - 2026-08-25

### Added

- Always-on mini dashboard for provider, model, current-session Token usage, estimated cost and cache hit.
- Drag-and-drop positioning with viewport clamping and browser-local persistence.
- Mini card, icon-only and off modes, plus a position reset in Settings.

### Changed

- The floating surface automatically yields while the full quota drawer is open and restores after it closes.
- Mobile defaults keep the dashboard above DSH's bottom controls and preserve a safe viewport margin.

## [0.4.0] - 2026-08-25

### Added

- Sidebar footer status entry that stays available outside active sessions.
- Desktop drawer and responsive mobile bottom sheet with keyboard focus control.
- Gap-free seven-day Token chart and 30-day provider/model breakdown.
- Browser-local per-model CNY price editor with Host-price restore.
- Six credential-free local-accounting routes: Moonshot/Kimi, Zhipu GLM, Alibaba Bailian, Volcengine Ark, Together AI and Fireworks AI.
- Safe route diagnostics copy and local usage JSON export.
- GitHub CI, contribution, security and issue templates.

### Changed

- Moved the quota entry out of the composer action row.
- Expanded the panel from three to four sections: overview, usage, providers and settings.
- An empty peak-hours schedule now means no time-based discount; configured prices are no longer silently halved.

### Fixed

- Read the official flat `tokenUsage` wire projection while retaining compatibility with the older nested shape.

## [0.3.0] - 2026-08-24

- Added five billing-provider adapters, local usage persistence, route-aware provider resolution, cache fallback and the first complete quota center UI.
