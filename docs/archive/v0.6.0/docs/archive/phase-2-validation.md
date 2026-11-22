# 阶段 2 验证报告

> 历史阶段快照：用例数量、版本和当时结论不代表当前状态。当前结果见 [验证总览](../validation/README.md)。未纳入 evidence 的原始日志和产物仅保留在本地。

状态：**阶段 2 已实现并通过本地验收**。版本 `0.2.0-dev.0`，private、未发布。正式源码位于本目录；只修改 `opencode-self-driving/`，没有修改宿主 Core、Server、Protocol、生成客户端、workspace 或 lockfile。

本轮使用真实公开 SDK / 插件 API、原生 AI provider / Evaluation 实现、实际 loopback HTTP、测试 key 和隔离数据库。没有调用真实模型服务，没有读取真实 provider 凭证，没有连接或修改已安装 OpenCode 的服务 / 配置。以下结果不扩大为真实账号、模型质量、tokenizer、已安装客户端或生产资格。

## 已实现

| 模块                                                                 | 行为                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [配置 schema](../../src/config.ts)                                   | 五档与固定辅助配对、原生绑定、凭证引用、显式预算；未知字段拒绝，没有数值默认值                                             |
| [server](../../src/server.ts)、[RPC](../../src/rpc.ts)               | Location 单活动 profile；草稿 / 发布分开；启用 / 关闭等待 idle；恢复完整模型 / variant，保留后来的手动选择；状态与脱敏诊断 |
| [原生后端 / 容量](../../src/native.ts)                               | OpenAI Chat / OpenRouter；原生活动 key 与显式 env；目录、variant、联合容量与 compaction 覆盖校验                           |
| [原生决策](../../src/decisions.ts)                                   | TypeSafeAI、OpenCode、OpenRouter、VercelAIGateway 四个现有 Evaluation selector；合法 Choice、返回身份与原生分布契约        |
| [证据](../../src/evidence.ts)                                        | 可复现 bounded / full 视图；完整 system / 用户约束 / 当前 exchange / 工具目录；候选能力与目录价格；省略范围与 view hash    |
| [流桥接](../../src/bridge.ts)、[错误](../../src/error.ts)            | 文本 / reasoning / metadata / 函数工具与用量；实际 HTTP body 复核；跨包错误互操作、原生 overflow 与取消                    |
| [说明](../configuration.md)、[配置模板](../../examples/profile.json) | 普通加载、headless RPC、明确的支持集与待填写预算                                                                           |

加载保持 `unconfigured`；发布后才贡献 `self-driving/auto`。上下文仍 `inherit`、审批仍 `off`。没有固定标题、fixture tokenizer、私有 resolver、额外服务协议或自建 agent loop。

配置和原模型选择通过公开 storage 保存；路由与失败诊断仅在内存中保留最近一项，不保存第二份 transcript 或待恢复决策。完整生命周期竞争和插件恢复仍在后续阶段。

## 基线与结果

- 日期：2026-10-18，macOS，Bun `1.4.2`。
- 验证宿主：OpenCode `2.0.32`、commit `501b15af26915ba52682e20e220e7e137e89e92f`，开发 worktree `plugin-routing-proof`。
- 从本目录构建、打包和测试；开发依赖链接到该宿主，链接不进入产物。SDK 只作为开发宿主，runtime graph 不包含 SDK。
- `ensurePluginRuntime()` 仅在测试宿主中启用公开共享模块机制，与 CLI 启动一致；不把它作为产品插件的初始化职责。

| 检查                       | 结果                                                                                         | 本地证据                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 包内 `bun run check`       | 类型检查、构建、声明、41 场景通过                                                            | 日志（本地原始资料：`artifacts/0.2.0-dev.0/check.log`）、JUnit（本地原始资料：`artifacts/0.2.0-dev.0/results.xml`）                     |
| 随机顺序重复 10 轮         | seed `237911`；**410 通过、0 失败、1,200 条断言**                                            | 日志（本地原始资料：`artifacts/0.2.0-dev.0/repeated-results.log`）、JUnit（本地原始资料：`artifacts/0.2.0-dev.0/repeated-results.xml`） |
| import boundary            | 98 inputs、禁止依赖 0；宿主 plugin / Effect external；只有 `buffer` 为 Node builtin external | 审计（本地原始资料：`artifacts/0.2.0-dev.0/import-boundary.json`）                                                                      |
| 包内显式宿主 oxlint        | 20 个代码文件，0 warning、0 error                                                            | 日志（本地原始资料：`artifacts/0.2.0-dev.0/package-lint.log`）                                                                          |
| 宿主根目录 `bun run check` | 34 项 typecheck 成功；lint 0 错误、1,306 条既有 warning                                      | 日志（本地原始资料：`artifacts/0.2.0-dev.0/host-check.log`）                                                                            |
| 本地 tarball               | 17 个文件；普通配置加载、离线安装、迁移与 Effect 单实例验证通过                              | 产物（本地原始资料：`artifacts/0.2.0-dev.0/opencode-self-driving-0.2.0-dev.0.tgz`）                                                     |

本包位于宿主 workspace glob 之外，宿主检查不能替代包内检查。证据目录和 dist 均被 git 忽略，没有 hosted CI / release 结果。

## 41 个场景覆盖什么

34 个路由 / 配置 / 原生协议集成场景，另有 5 个包 / 生命周期回归与 2 个证据单元测试，均运行实际实现而非重复测试逻辑。

- 四种原生 Evaluation selector 分别经过实际 HTTP；两种原生生成 factory 分别验证其 reasoning 参数；五档都派发到配置的模型。
- 保存草稿不生效；非法字段、不可用 effort、缺凭证与发布失败保留原可用配置。原生 integration key 实际用于生成，配置 / status 不回显 key；OAuth / external 在解析前拒绝，未测试或宣称它们能生成。
- 启用 / 关闭保留原模型与 variant，手动改选模型后关闭不覆盖用户选择；配置与先前选择可跨 unload / reload 保留。
- 多候选走合法 Choice；仅 max 合格时跳过决策，决策预算为 1 也不会误调用；候选为空时在任何模型请求前失败。
- 非法 Choice、异常返回模型、输入超限均阻止生成。System One 缺分布会失败，Vercel 缺分布可通过；`.98` 的合法舍入分布原样保留，confidence 为 `0` 也不会被通用阈值拒绝。
- 真实工具调用由 Core 执行，工具结果进入下一 Step，并重新决策；不同 Session 的并发绑定隔离。
- title / compaction / Session generate 使用固定配对；summary 与 checkpoint 由 Core 处理。实际 provider overflow 经打包后的错误桥接触发 Core compaction，重新准备后继续成功。
- 决策 deadline 取消等待中的真实 HTTP，请求确实在 loopback 服务端断开；没有把 Promise.race 当作取消证明。
- 其他插件在本插件后扩大输入，发送前会拒绝且不调物理后端、不隐藏重试。协议构造后合并的 HTTP body overlay 也在真正的发送边界检查，已绑定 medium 不会偷换更大模型。
- 全局生成在其 base configuration Location 发布组合模型后仍因缺少 Session binding 明确拒绝，而非仅依赖“找不到模型”。
- bounded 证据保留可见用户约束和完整工具 exchange，省略可复现；full / 必需证据超预算失败，不截断生成历史。
- tarball 离线安装后经普通目录配置加载；直接、间接及公开子路径 Effect 共享宿主实例，毒化的私有副本未被使用。

## 两个打包边界的实际修正

**错误身份。** 宿主用 `instanceof AIError` 识别原生错误，打包后的 AI class 不应被假定与宿主相同。插件拥有的拒绝和原生流失败通过已有 AI SDK `APICallError` 的跨包标记传递；不复制 Core 错误转换。测试验证了本地容量拒绝不触发隐藏重试，以及真实 HTTP overflow 仍能进入原生压缩。错误传递保留必要分类和重试性，清除原始 body、HTTP headers 与 cause。

**最终 payload。** `route.body.from` 只是中间对象，后续还可能合并原生 HTTP body。现在生成在公开 `RequestExecutor.middleware` 的实际发送边界核对最终 JSON 的模型、输出与总容量。覆盖模型、输入、工具、输出、reasoning 的 body，以及原生 `models` fallback 数组与压缩请求不属于当前支持集，明确拒绝。

## 当前限制与 review 项

1. 这是原生 API 的本地协议资格，不是账号 / 真实服务资格。OpenAI Chat / OpenRouter 之外的后端、OAuth、external、WebSocket、媒体、托管工具和结构化输出尚不支持；不补齐私有 resolver 或登录流程。
2. 编码使用 `utf8-bytes` 加显式余量，决策也单独限制真实序列化 body。它是保守估算，不是 tokenizer；可能拒绝实际能容纳的输入。不能据 native 目录窗口宣称端到端 1M。
3. 当前只有一个 route 问题；决策 token 上限需按服务每请求 / 每问题限制中较小的已验收值填写。没有长上下文开关、多问题批量或模型别名稳定性资格声明。
4. 输出、余量、deadline 与输入预算都必须显式填写。模板中的 `0` / 模型占位符会被拒绝，尚未决定正式默认值；无新增置信度门槛。
5. 原生目录信息 / 静态配置可使用，不声称复用了全部 Session HTTP hooks、私有账户 header 或特殊协议行为。真实模型、特殊 compatibility、工具与 reasoning 质量需逐配对验收。
6. Core 保持组合模型身份。状态记录请求物理模型、概率及实际报告的用量，不独立证明返回物理身份，不把 Core 的组合模型费用当作物理账单。
7. 已验证常规 reload、跨 Session 并发、决策 deadline 与 overflow；快速重启、延迟终止事件、全部重载 / 重试 / 取消竞争仍归阶段 4。不是 exactly-once 或恢复验收。
8. 上下文选择与自动审批仍分别为 inherit / off，阶段 3 开始；TUI / 命令表单与已安装客户端集成归阶段 6。

配置的当前选择为“每 Location 一个显式 profile，通过 RPC 管理”，供本轮 review；未添加全局 / 项目隐式合并或配置向导。

## 复跑

使用 Bun `1.4.2`，从本目录执行：

```sh
bun run dev:link /path/to/qualified/opencode
bun run check
bun run test -- --rerun-each 10 --randomize --seed=237911
```

依赖已安装的验证 worktree 根目录执行 `bun run check`；包目录还可用宿主 `oxlint` 显式检查 `src script test server.js rpc.js`。下一阶段接入资源 / 审批前，继续保留这些回归与逐绑定资格边界。
