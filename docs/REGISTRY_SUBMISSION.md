# DSH registry submission

This file keeps the future `awesome-dsh-plugin` submission reproducible. Do not open the registry pull request until the repository is at least one day old and contains at least ten meaningful commits.

## Repository topics

Add these topics in the GitHub repository **About** panel:

```text
dsh-plugin
deepseek-harness
quota-monitor
token-usage
cost-tracking
multi-provider
```

`dsh-plugin` is required by the registry; the remaining topics improve GitHub discovery.

## Registry entry

Create `data/plugins/Lottle7__dsh-quota.yml` in a fork of `awesome-dsh-plugin/awesome-dsh-plugin`:

```yaml
url: https://github.com/Lottle7/dsh-quota
name: Lottle7/dsh-quota
category: usage
tarball: https://github.com/Lottle7/dsh-quota/releases/latest/download/dsh-quota.tgz
description:
  en: Multi-provider quota, balance and Token-cost dashboard with local pricing, usage analytics and route diagnostics.
  zh: 多平台额度、余额与 Token 成本面板，提供本地价格、用量分析和路由诊断。
```

The description is intentionally factual and avoids version-specific provider counts, so it does not become stale when another adapter is added.

## Storefront screenshot

Add this key to `data/screenshots.json` in the same pull request:

```json
"https://github.com/Lottle7/dsh-quota": [
  "https://raw.githubusercontent.com/Lottle7/dsh-quota/main/docs/assets/quota-center.png"
]
```

Then run the registry's documented validation commands:

```bash
npm ci
node scripts/generate-readme.mjs
```

Commit the plugin entry, generated English/Chinese READMEs, and screenshot registry change together. Do not edit another plugin entry.
