# dsh-quota

[English](README.md) | 简体中文

[![CI](https://github.com/Lottle7/dsh-quota/actions/workflows/ci.yml/badge.svg)](https://github.com/Lottle7/dsh-quota/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-43853d.svg)](package.json)

DSH Web 的多平台额度、余额、Token 成本与路由诊断中心。当前版本为 `0.8.0`。

插件直接跟随 DeepSeek HARNESS 的当前 `Session` 和该会话的模型选择，区分“模型厂商”和“实际计费平台”。例如会话通过 OpenRouter 使用 MiniMax 模型时，额度仍归到 OpenRouter，不会误查 MiniMax。

![dsh-quota 额度中心](docs/assets/quota-center.png)

## 当前能力

- 跟随当前会话：订阅 DSH `sessions.currentProvideInfo`、`tokenUsage` projection 和会话级 `modelDirectories`。
- 远端额度：统一展示余额、5 小时/周额度窗口、Key 消费限额与平台侧用量。
- Host 用量账本：按每次模型调用持久化 Token，并从已有 Session 日志安全回填，无需恢复或运行 Agent。
- 本地用量：按平台和模型统计当前会话、今日、近 30 天 Token 及估算费用；完整汇总不受明细分页条数影响。
- 悬浮仪表盘：默认常驻显示当前平台、模型、会话 Token、估算费用与缓存命中；可拖动、折叠成图标或关闭，并记住位置。
- 用量分析：展示连续 7 日趋势和近 30 天平台/模型拆分，空闲日期不会被压缩掉。
- 可靠计数：同一 turn/step 的流式与最终 usage 采用覆盖语义，刷新页面、重启 Host 或切换模型不会重复计数。
- 历史迁移：旧版浏览器汇总只导入 Session 日志未覆盖的差额，升级后历史不丢失也不重复。
- 逐次明细：展示调用的模型、路由/计费平台、输入输出 Token、费用、时间和 turn/step，支持游标分页与加载更多。
- 明细筛选：可按计费平台、精确模型、数据来源或关键字查询 Host 账本。
- 费用预算：支持每日和滚动 30 天人民币预算，可配置 50–100% 预警线，并在总览、用量页和悬浮卡联动提醒。
- 定价完整性：存在未配置价格的模型时明确提示，不会把不完整的 0 元或部分费用当成安全状态。
- 模型价格：可直接在界面为任意模型设置人民币/百万 Token 价格；浏览器覆盖可随时恢复为 Host 配置。
- 安全诊断：显示 route、计费平台、模型厂商、解析置信度和缓存状态，可复制不含凭据的诊断报告。
- 数据导出：可导出本地趋势/模型拆分 JSON，也可把全部筛选后的 Host 明细导出为 CSV。
- 自动与固定模式：默认跟随会话，也可固定查看某个平台；固定查看不会修改会话模型。
- 缓存与容错：GET 使用可配置 TTL，手动刷新强制请求；并发请求合并；失败时保留上一次健康快照。
- 安全边界：凭据只在 Host 解析，响应递归脱敏；写请求要求 JSON；插件路由校验 Host、Origin 和 `Sec-Fetch-Site`。
- 自定义平台：可通过 Host 设置添加本地计费路由，或映射第三方公共 HTTPS JSON 余额/用量接口；平台卡片和会话路由会自动接入。
- 中英文界面：侧边栏状态入口、总览/用量/平台/设置四个页签、桌面抽屉、移动端底部面板和深浅色适配。

## 支持的平台（11 个内置 + 自定义）

原生账户查询：

| 平台 ID | 展示内容 | Host 凭据 |
|---|---|---|
| `minimax-cn` | MiniMax 国内 Coding Plan 额度窗口 | `MINIMAX_CN_API_KEY` / `MINIMAX_CN_COOKIE`，并兼容通用名称 |
| `minimax-intl` | MiniMax 国际 Coding Plan 额度窗口 | `MINIMAX_INTL_API_KEY` / `MINIMAX_INTL_COOKIE`，并兼容通用名称 |
| `deepseek-official` | DeepSeek 官方多币种账户余额 | `DEEPSEEK_API_KEY` |
| `openrouter` | 当前 Key 用量、消费限额、剩余额度和重置周期 | `OPENROUTER_API_KEY` 或 `OPENROUTER_KEY` |
| `siliconflow` | SiliconFlow 充值余额、赠送余额和总余额 | `SILICONFLOW_API_KEY` 或 `SILICONFLOW_KEY` |

上表只列有可验证账户/Key 查询接口的平台。除此之外，可以通过 `customProviders` 添加自己的平台，无需修改插件源码、UI 或路由主流程。

本地 Token/费用归集（不请求平台账户接口、不需要额外凭据）：

| 平台 ID | 路由别名示例 | 展示内容 |
|---|---|---|
| `moonshot` | `moonshot`、`kimi` | DSH Token、价格和费用趋势 |
| `zhipu` | `zhipu`、`bigmodel`、`glm` | DSH Token、价格和费用趋势 |
| `alibaba-bailian` | `dashscope`、`bailian` | DSH Token、价格和费用趋势 |
| `volcengine-ark` | `volcengine`、`ark`、`doubao` | DSH Token、价格和费用趋势 |
| `together` | `together`、`together-ai` | DSH Token、价格和费用趋势 |
| `fireworks` | `fireworks`、`fireworks-ai` | DSH Token、价格和费用趋势 |

这六个平台不是假余额占位：插件明确标记为“本地计费”，只根据 DSH 的实际 Token projection 和用户价格表统计。未来只有在平台提供稳定、官方、可由 API Key 调用的账户端点后，才会升级为原生余额/额度查询。

## 安装

推荐把预构建的 Release 安装到 DSH Web profile，然后重启 DSH Web：

```bash
dsh plugin --profile web add "https://github.com/Lottle7/dsh-quota/releases/download/v0.8.0/dsh-quota.tgz"
dsh web
```

预构建包不需要在本机编译 TypeScript。也可以安装带版本的 GitHub 源码；pnpm 10 或更高版本若提示 `allowBuilds`，请按提示允许该包的构建脚本后重试：

```bash
dsh plugin --profile web add "github:Lottle7/dsh-quota#v0.8.0"
```

升级时把上述 Release URL 换成新版本；卸载使用：

```bash
dsh plugin --profile web remove dsh-quota
```

添加、升级或移除 Bundle 后都需要重启 `dsh web`。

## 本地开发

在插件目录构建并验证：

```bash
npm install
npm run typecheck
npm test
npm run test:loader
```

从仓库根目录把本地 checkout 链接到 Web profile：

```bash
dsh plugin --profile web add .
```

包内 `cordis.patch.yml` 会插入 `dsh-quota` 行；客户端声明并注入会话、布局、侧边栏和模型选择所需的 DSH client bundles。修改后重新构建并重启 `dsh web`。悬浮迷你仪表盘默认开启，额度入口也保留在侧边栏底部；绿色、黄色和红色状态点分别表示健康、需要关注和失败状态。

## 界面结构

- **总览**：当前计费平台的余额/额度窗口，以及今日费用、Token、缓存命中和平台连接摘要。
- **用量**：当前会话、今日、近 30 天、Host 历史同步、连续 7 日图表、平台/模型排行、明细筛选/分页和 CSV 导出。
- **平台**：查看全部内置及自定义平台，并在不修改会话模型的前提下固定查看；自定义平台会标注“自定义”。
- **设置**：切换悬浮迷你面板/图标/关闭并重置位置，编辑每日/30 天费用预算和模型本地价格，检查路由解析链路，复制脱敏诊断和导出用量。

悬浮仪表盘的位置和显示模式保存在当前浏览器，不会同步到 Host，也不会包含凭据。完整额度中心打开时，悬浮仪表盘会自动隐藏，关闭抽屉后恢复。

## 配置

设置命名空间为 `dsh-quota`：

```yaml
dsh-quota:
  enabled: true
  refreshIntervalMs: 60000       # 15000 ~ 86400000
  warningBalanceBelow: 10
  warningQuotaRemainingBelow: 0.2
  usageRetentionDays: 90          # 30 ~ 3650

  # 路由名无法自动识别时，显式指定实际计费平台。
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

  # 自定义本地计费平台：只归集 DSH Token/价格，不访问远端。
  customProviders:
    - id: my-company-relay
      displayName: My Company Relay
      kind: local
      description: 公司内部模型网关
      region: CN
      brandColor: "#2563eb"
      routeAliases: [my-relay, company-llm]
      modelVendors: [deepseek, qwen]

    # 自定义账户接口：只允许公共 HTTPS GET，凭据值不写在这里。
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

  # 非 loopback 访问 Web UI 时必须显式信任 authority；有端口就一并填写。
  trustedHosts:
    - 192.168.1.20:13521

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

`usageRetentionDays` 控制 Host 用量账本保留天数；界面默认查询最近 30 天。

### 自定义第三方平台

`kind: local` 适合没有账户查询接口的中转站或私有路由：它不需要端点和凭据，只把当前会话的 Token、价格与费用归到该平台。

`kind: http-json` 会把一个受限的 JSON 账户接口映射成余额、平台用量和消费限额。`balancePath`、`usagePath`、`limitPath`、`remainingPath` 是点分 JSON 路径，例如响应 `{"data":{"balance":"42.5"}}` 对应 `data.balance`。这些字段至少配置一个；数字或数字字符串均可。`valueScale` 会乘到所有映射值上，例如上游以千分之一美元为单位时填 `0.001`。

`credentialRef` 是 DSH Host 凭据引用/环境变量名，不是密钥本身。请通过 DSH 凭据存储或启动 `dsh web` 的 Host 环境提供同名值，例如 `ACME_API_KEY`；不要把真实 Token 写进 YAML。设置更新后，平台注册表、路由别名、开关和平台卡片会一起刷新。自定义平台也可出现在 `providerEnabled` 和 `routeMappings` 中。

价格表与预算只用于浏览器本地估算和提醒，不会阻止模型调用或改变任何平台账单。若 `peakHours.windows` 为空，则表示不启用分时价格，插件会原样使用配置价格；只有显式配置峰时窗口时，窗口之外才采用 50% 折扣。

也可以在“额度中心 → 设置”中输入模型 ID 和三项价格，并设置每日/滚动 30 天预算及预警比例。界面保存的价格与预算位于当前浏览器 `localStorage`，不含任何凭据；价格优先级高于 Host 同模型配置，点击“恢复 Host 价格”即可删除价格覆盖。

## 路由解析规则

1. `routeMappings` 显式配置优先。
2. 精确匹配平台注册的 route alias。
3. 只能从模型 ID 推断模型厂商，不能据此改写计费平台。
4. 无法确认计费平台时返回 `unknown/unsupported`，不猜测、不展示假余额。

客户端会把当前 Session 的 `sessionId`、provider、model 和 reasoning effort 传给 Host；Host 再解析计费平台。插件不再使用 `agentDefaultModel` 代替当前会话，因此不会出现多会话和切换模型时读错平台的问题。

## 安全说明

- API Key/Cookie 经 DSH credentials service 动态解析，不写入浏览器状态、localStorage、日志或快照。
- Host 账本只保存 Session 标识、turn/step、时间、路由/模型和 Token 桶，不保存提示词、回复正文、工具参数、API Key 或 Cookie。
- 浏览器只保留 UI 偏好、本地价格/预算覆盖和兼容汇总镜像，不持久化消息正文。
- 平台 API 响应和 `QuotaSnapshot` 在存储及出站前递归脱敏；用量接口只从封闭校验过的数值账本结构生成响应。
- 自动刷新走缓存，避免高频调用上游；点击刷新才强制请求。
- `0.0.0.0` 暴露是 DSH Web Server 的部署选择。若从局域网访问，需要在 `trustedHosts` 明确列出浏览器使用的 authority，并由反向代理承担 TLS/认证。
- 自定义账户接口只允许公共 `https://`、443 端口、无查询参数的 GET；禁止私网/loopback/保留地址、重定向、URL 内嵌凭据和任意请求头。
- Host 会校验全部 DNS 结果并把 TLS 连接固定到已校验地址，限制响应为 256 KiB；认证只允许 Bearer、`X-API-Key` 或无认证，字段映射只能读取安全的点分路径。
- `credentialRef` 只能引用 Host 凭据；插件的额度 API 只返回归一化数字和安全元数据，不会返回端点配置、原始响应或密钥。

## 常见问题

- `not-configured`：未找到该平台声明的凭据名称。
- `auth-error`：凭据存在但上游拒绝；MiniMax 国内和国际凭据/会话 Cookie 可能不通用。
- `rate-limited`：上游限流；服务会退避并保留健康快照。
- `unsupported`：当前 route 没有 adapter；在 `routeMappings` 指定真实计费平台。
- 用量正常但费用显示“未配置价格”：在“设置”页为当前模型保存价格，或在 Host `pricing.overrides` 中配置。
- 局域网页面返回 403：把实际的 `host:port` 加入 `trustedHosts`，并确保 Origin 与 Host 一致。

## 兼容性与质量门

- Node.js 22 或更高版本。
- 面向 DSH `0.1.1-rc.2` 或更高版本 Web profile（需要官方 storage-domain 与 Session inspect 服务）；升级 DSH 后建议先执行 Loader smoke。
- CI 在 Node.js 22/24 上执行 TypeScript、单元测试、客户端 Loader smoke 和发布包清单检查。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告；平台适配器贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 插件目录投稿所需的条目、预构建包地址、截图和 GitHub Topics 已整理在 [DSH registry submission](docs/REGISTRY_SUBMISSION.md)。

## 主要代码

- Host 注册与 DSH 注入：`src/host/index.ts`
- 当前会话与 token projection：`src/client/index.tsx`
- 平台适配器：`src/host/adapters/`
- 路由与信任校验：`src/host/routes.ts`
- 本地用量持久化：`src/client/usage-store.ts`
- 浏览器价格覆盖：`src/client/pricing-preferences.ts`
- 面板与样式：`src/client/quota-panel.tsx`、`src/client/styles.css`
