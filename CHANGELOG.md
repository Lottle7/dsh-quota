# Changelog

All notable changes to this project are documented in this file. The project
follows [Semantic Versioning](https://semver.org/).

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
