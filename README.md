# dsh-quota

English | [简体中文](README.zh.md)

[![CI](https://github.com/Lottle7/dsh-quota/actions/workflows/ci.yml/badge.svg)](https://github.com/Lottle7/dsh-quota/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Lottle7/dsh-quota)](https://github.com/Lottle7/dsh-quota/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-4f46e5)](https://github.com/deepseek-ai/deepseek-harness)

Multi-provider quota, balance, and Token-cost dashboard for **DeepSeek Harness (DSH) Web**.

`dsh-quota` follows the active DSH Session and distinguishes the model vendor from the route that actually bills it. If a Session runs a MiniMax model through OpenRouter, usage remains attributed to OpenRouter. It combines five native account integrations, six built-in local-accounting routes, configurable third-party providers, a draggable always-on widget, usage analytics, local model pricing, and safe route diagnostics.

![dsh-quota quota center](docs/assets/quota-center.png)

## Install

Install the prebuilt release into the DSH Web profile, then restart DSH Web:

```bash
dsh plugin --profile web add "https://github.com/Lottle7/dsh-quota/releases/download/v0.8.0/dsh-quota.tgz"
dsh web
```

The prebuilt archive does not require a local TypeScript build. To install the tagged source instead, use the command below and follow pnpm's `allowBuilds` prompt if pnpm 10 or later asks for it:

```bash
dsh plugin --profile web add "github:Lottle7/dsh-quota#v0.8.0"
```

## Highlights

- Follows the active Session's route, model, reasoning effort, and official `tokenUsage` projection.
- Shows the provider's balance, quota windows, key spending limit, and provider-side usage when its API exposes them.
- Persists a deduplicated per-call usage ledger in DSH Host storage and backfills existing Session logs without resuming Agents.
- Tracks current-Session, daily, and rolling 30-day Tokens and estimated CNY cost by billing platform and model, using complete Host aggregates independently of history-page size.
- Keeps a draggable mini dashboard visible while you work; switch it to icon-only mode, hide it, or reset its position.
- Migrates the pre-v0.6 browser aggregates as uncovered remainders, so upgrades preserve history without double-counting Session logs.
- Shows historical-sync progress and pageable call-level model, route, Token, cost, time, turn, and step details.
- Filters call history by billing provider, exact model, source or search text, and exports every matching row as CSV.
- Supports browser-local daily and rolling 30-day CNY budgets with a configurable warning threshold and progress in the drawer and floating dashboard.
- Detects partially unpriced usage and asks for missing model prices instead of presenting an incomplete estimate as safe.
- Displays a gap-free seven-day trend and a 30-day provider/model breakdown, with summary JSON export.
- Lets you edit per-model CNY-per-million-Token prices in the browser and restore Host defaults at any time.
- Explains route resolution, billing provider, model vendor, confidence, and cache state in a credential-free diagnostic report.
- Supports desktop drawers, a responsive mobile bottom sheet, light/dark themes, and Chinese/English UI copy.
- Registers custom local-accounting routes or hardened public HTTPS JSON billing endpoints directly from Host settings.

## Supported platforms

Native account queries:

| Platform | What is displayed | Host credential |
|---|---|---|
| MiniMax China | Coding Plan quota windows | `MINIMAX_CN_API_KEY` or `MINIMAX_CN_COOKIE` |
| MiniMax International | Coding Plan quota windows | `MINIMAX_INTL_API_KEY` or `MINIMAX_INTL_COOKIE` |
| DeepSeek Official | Multi-currency account balance | `DEEPSEEK_API_KEY` |
| OpenRouter | Key usage, spending limit, remaining allowance, and reset cadence | `OPENROUTER_API_KEY` or `OPENROUTER_KEY` |
| SiliconFlow | Recharge, gifted, and total balance | `SILICONFLOW_API_KEY` or `SILICONFLOW_KEY` |

Local Token and cost accounting, without an additional provider credential:

| Platform | Route aliases |
|---|---|
| Moonshot / Kimi | `moonshot`, `kimi` |
| Zhipu GLM | `zhipu`, `bigmodel`, `glm` |
| Alibaba Bailian | `dashscope`, `bailian` |
| Volcengine Ark | `volcengine`, `ark`, `doubao` |
| Together AI | `together`, `together-ai` |
| Fireworks AI | `fireworks`, `fireworks-ai` |

Local-accounting integrations never invent a balance. They report only the Token projection supplied by DSH and the price table configured by the user.

## Interface

- **Overview** — active billing-platform balance/quota, today's Token cost and connection summary.
- **Usage** — Session, today and 30-day totals, Host history sync, seven-day chart, provider/model rankings, filtered call history, pagination, and CSV export.
- **Providers** — inspect all built-in and custom integrations or pin one for viewing without changing the Session model.
- **Settings** — control the floating widget, edit cost budgets and local prices, inspect route resolution, copy diagnostics, and export usage.

The floating widget's mode and position are browser-local. It temporarily yields while the full quota center is open and returns when the drawer closes.

## Configuration

The Host settings namespace is `dsh-quota`:

```yaml
dsh-quota:
  enabled: true
  refreshIntervalMs: 60000
  warningBalanceBelow: 10
  warningQuotaRemainingBelow: 0.2
  usageRetentionDays: 90

  # Use an explicit mapping when a custom route name cannot be identified.
  routeMappings:
    my-company-openrouter: openrouter

  providerEnabled:
    minimax-cn: true
    minimax-intl: true
    deepseek-official: true
    openrouter: true
    siliconflow: true
    moonshot: true
    zhipu: true
    alibaba-bailian: true
    volcengine-ark: true
    together: true
    fireworks: true

  customProviders:
    # Local accounting only: no remote request and no extra credential.
    - id: my-company-relay
      displayName: My Company Relay
      kind: local
      description: Internal model gateway
      region: Global
      brandColor: "#2563eb"
      routeAliases: [my-relay, company-llm]
      modelVendors: [deepseek, qwen]

    # Restricted public HTTPS JSON account endpoint.
    - id: acme-billing
      displayName: ACME Billing
      kind: http-json
      endpoint: https://billing.example.com/v1/account
      credentialRef: ACME_API_KEY
      auth: bearer                 # bearer | x-api-key | none
      balancePath: data.balance
      usagePath: data.usage
      limitPath: data.limit
      remainingPath: data.remaining
      currency: USD
      valueScale: 1
      routeAliases: [acme, acme-relay]

  pricing:
    default:
      inputCacheHitPerMTokCNY: 0
      inputCacheMissPerMTokCNY: 0
      outputPerMTokCNY: 0
    overrides: {}
    peakHours:
      weekdays: []
      windows: []
      timezone: Asia/Shanghai
```

`usageRetentionDays` accepts 30–3650 days and controls the Host ledger retention window. The dashboard queries the latest 30 days by default.

### Custom providers

Use `kind: local` for a relay or private route without an account endpoint. It makes no remote request and attributes DSH Tokens and local prices to that billing provider.

Use `kind: http-json` to map a restricted JSON account endpoint into balance, provider usage, and a spending limit. The four mapping fields are safe dot paths: for `{"data":{"balance":"42.5"}}`, use `balancePath: data.balance`. Configure at least one path. Numeric strings are accepted, and `valueScale` multiplies every mapped value (for example, use `0.001` when the upstream unit is one-thousandth of the configured currency).

`credentialRef` names a DSH Host credential/environment reference; it is never the literal key. Store the same reference through DSH credentials or provide it to the Host environment that starts `dsh web`. Custom IDs can also be used in `providerEnabled` and `routeMappings`. Live Host-settings changes rebuild the registry and provider cards without changing the current Session model.

Prices and budgets are estimates/alerts only: they never block a model call or modify a provider bill. An empty `peakHours.windows` disables time-based discounts. Browser price and budget overrides stay in `localStorage`; model prices take precedence over matching Host prices and neither preference contains credentials.

## Privacy and security

- API keys and cookies are resolved only through the DSH Host credential service.
- Credentials are not sent to the browser, stored in the usage ledger, or included in diagnostics.
- The Host ledger stores only Session identity, turn/step, timestamp, route/model, and Token buckets in DSH's storage domain; it never stores prompts, replies, tool payloads, API keys, or cookies.
- The browser keeps UI preferences, local price/budget overrides, and a compatibility aggregate mirror; message content is never persisted by this plugin.
- Provider API responses and quota snapshots are recursively redacted; usage responses are emitted only from a closed, validated numeric ledger shape.
- Write routes require JSON and validate Host, Origin, and `Sec-Fetch-Site`.
- Custom account endpoints are restricted to public HTTPS GET on port 443, without query strings, redirects, embedded credentials, private/reserved addresses, or arbitrary headers.
- The Host validates every DNS result and pins the TLS connection to a validated address, caps responses at 256 KiB, and permits only Bearer, `X-API-Key`, or no authentication.
- The plugin's quota APIs return normalized numbers and safe metadata only—not endpoint configuration, raw responses, or keys.

Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## Compatibility

- Node.js 22 or later.
- DeepSeek Harness `0.1.1-rc.2` or later Web profile (requires the official storage-domain and Session inspection services).
- CI verifies Node.js 22 and 24 with type checking, unit tests, a client Loader smoke test, and package-content validation.

DSH is still evolving through release candidates. Run the Loader smoke test after upgrading DSH before deploying the plugin broadly.

## Update or remove

Install a newer prebuilt archive with the same `dsh plugin` command and its new version URL. To remove the bundle:

```bash
dsh plugin --profile web remove dsh-quota
```

Restart `dsh web` after adding, updating, or removing a bundle.

## Development

```bash
npm install
npm run test:ci
```

To link a local checkout into the Web profile, run this from the repository root:

```bash
dsh plugin --profile web add .
```

The package declares `cordis.patch.yml` as a DSH bundle. The patch mounts both the Host provider registry and the browser client. See [CONTRIBUTING.md](CONTRIBUTING.md) for adapter and pull-request guidance.

The prepared [DSH registry submission](docs/REGISTRY_SUBMISSION.md) records the marketplace entry, prebuilt tarball URL, screenshot, and required GitHub topics.

## License

[MIT](LICENSE)
