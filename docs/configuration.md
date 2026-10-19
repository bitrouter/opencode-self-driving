# 配置与运行机制

安装与加载见 [安装指南](installation.md)，开发检查见 [开发指南](development.md)，当前证据见 [验证总览](validation/README.md)。本页描述当前配置、TUI / RPC、资源、审批和生命周期行为。

加载后保持 `unconfigured`。保存并发布完整配置后，才注册 `self-driving/auto`；显式启用 Session 才会切换模型。上下文选择默认 `inherit`，自动审批默认 `off`，通过独立 TUI 策略命令或 RPC 启用。插件使用 Core 的工具执行、后续 Step、原生摘要与 overflow 处理，不运行自己的 agent loop。

一次真实文件修改任务的对照中，当前配置弱于固定 GPT-4.1 Mini，双方均未通过完整验收；发现的多段纯文本工具结果 bridge 缺口已修复。结果与开销见 [编码任务对照](validation/coding-task-live.md)，不声明编码质量或成本收益合格。

## 基线与支持集

本地验证宿主为 OpenCode `2.0.32`、commit `501b15af26915ba52682e20e220e7e137e89e92f`，Bun `1.4.2`，macOS。peer 版本精确锁定；不声明兼容全部 OpenCode 2.x 或旧插件 API。

| 用途 | 原生入口                                                                        | 本阶段的凭证支持                                     |
| ---- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 决策 | TypeSafeAI、OpenCode、OpenRouter、VercelAIGateway 的 `experimental.evaluation`  | 显式环境变量引用，或原生 integration 的活动 key 连接 |
| 生成 | `openai-chat` → 原生 OpenAI `chatModel`；`openrouter` → 原生 OpenRouter `model` | 同上；凭证解析和活动连接由宿主管理                   |

矩阵主要依据本地 loopback 协议和连接方式验证。OpenRouter 的原生 integration key、Jev 1.14 与 GPT-4.1 Nano 已完成真实接入 smoke，结果部分通过，见 [实测报告](validation/openrouter-live.md)；其他服务与配对尚无真实资格声明。OAuth / external 连接会被明确拒绝；不新增登录、refresh、alpha Decisions transport 或供应商 SDK。Vercel OIDC 如需使用，只能引用已有环境变量；插件不获取或刷新它。

生成配对必须指向公开目录中可用的模型，且 provider 的 canonical 身份、原生 package、模态、工具能力、有限容量和 variant 均匹配。`effort` 指模型目录中实际存在的 variant ID，使用它的完整 settings / headers / body；五个策略档位名与物理 effort 没有隐含对应。

当前生成绑定仅支持未压缩 JSON HTTP、文本 / reasoning、可移植 provider metadata、普通函数工具调用及文本 / JSON / 错误工具结果。模型必须支持工具和文本。WebSocket、native provider compaction、媒体、托管工具、其他 provider package、结构化输出，以及覆盖模型 / 输入 / 工具 / 输出 / reasoning 的 HTTP body 不在支持集合内。OpenAI 宿主 provider 默认可能选择 WebSocket，使用本绑定前需将其原生配置设为 HTTP。

绑定转交公开 provider / model / variant 的静态配置，不复制私有 resolver，也不声明复用了所有 Session HTTP hooks、账户行为或请求级插件改写。这些行为的真实兼容性仍需专项验收。

## 构建与普通加载

确保 Bun **1.4.2 在 PATH 上**，使嵌套脚本使用同一版本。从本目录执行：

```sh
bun run dev:link /path/to/dependency-installed/opencode
bun run check
```

省略 `dev:link` 的路径时使用父目录；已有兼容依赖时可以跳过。开发依赖链接只写入忽略的 `node_modules`，不修改宿主 manifest / lockfile，也不进入 tarball。

在普通 OpenCode 配置中加入目录，路径相对于配置文件：

```json
{ "plugins": [{ "package": "./opencode-self-driving" }] }
```

不接受 plugin options。普通配置会发现 server / rpc / tui 三个入口，headless 只加载 server 侧能力。安装产物与兼容边界见 [docs/installation.md](installation.md)。

## TUI 使用

| 命令                                  | 行为                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/self-driving` 或 `/self-driving on` | 配置未完成时进入配置；发布完成后显式启用当前 Session                                      |
| `/self-driving config`                | 导入 / 编辑完整 profile、选择原生模型和 variant、审阅、保存草稿或确认发布                 |
| `/self-driving policies`              | 独立设置当前 Session 的 context inherit / shadow / select 与 approval off / shadow / auto |
| `/self-driving status`                | 打开当前 Session 的状态面板；home 显示简要状态                                            |
| `/self-driving off`                   | 等待 idle、停用策略并恢复原模型和 variant                                                 |

相同操作也可从命令面板的 Self-driving 分组进入。第一次配置粘贴填好的 profile JSON；服务、凭证引用、预算和阈值使用完整 JSON 编辑，模型 / variant 使用原生目录选择器。发布前有明确确认；保存草稿保持当前发布配置。Home 可以配置，启用与策略操作需要已有 Session。

底栏显示开关与最近主档位，状态面板显示组合窗口、实际请求目标、合格 / 排除档位、资源和审批结论、已知 / 未知用量及失败。窄终端使用短底栏并换行面板正文；配色使用宿主语义 theme token。状态按公开生命周期 / 配置事件刷新，没有定时轮询或持久化观察器。

## Headless 配置与使用

使用 [profile 模板](../examples/profile.json) 填写已配置的原生 provider / 模型、决策模型与允许的返回身份、凭证引用、五档和辅助配对。模板的占位符和 `0` 必须替换，校验会拒绝这些未完成预算；它们不是正式默认值。

一个 Location 维护一个活动 profile，草稿与已发布版本分开。所有档位都必须完整；可把同一配对用于多个档位。显式设置输出、编码余量、证据 tokens / bytes、决策请求 tokens / bytes 和准备 deadline，没有隐式数值默认值。

通过现有公开 client：

```js
const rpc = (method, input = {}) =>
  client.rpc.call({
    rpcID: "opencode-self-driving",
    method,
    input,
    location: { directory: projectDirectory },
  })

await rpc("draft", { profile: await Bun.file("profile.json").json() })
await rpc("publish")
await rpc("enable", { sessionID })
const status = (await rpc("status", { sessionID })).output
await rpc("disable", { sessionID })
```

| RPC        | 输入                                        | 行为                                                                                         |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `config`   | `{}`                                        | 返回草稿和最后已发布版本；只含凭证引用                                                       |
| `draft`    | `{ profile }`                               | 严格校验字段并保存草稿，不影响当前配置                                                       |
| `publish`  | `{}`                                        | 校验模型、variant、凭证方式、联合容量与 compaction 覆盖范围，发布新 revision 并刷新 provider |
| `enable`   | `{ sessionID }`                             | 等待 Session idle，保存原模型和 variant，再选择组合模型                                      |
| `disable`  | `{ sessionID }`                             | 等待 idle 并恢复保存的完整选择；保留用户后来手动选择的其他模型                               |
| `status`   | `{ sessionID? }`                            | 返回配置、组合窗口、Session 开关和最近路由诊断                                               |
| `policies` | `{ sessionID, contextSelection, approval }` | 等待 idle，显式设置本 Session 的资源与审批模式，绑定当前发布 revision                        |

启用 / 关闭不隐式 interrupt。原模型或 variant 已不可用时，关闭会报错并交回用户选择；不另选 fallback。加载、保存、发布配置都不执行决策或模型生成。

配置与原模型选择通过公开 `ctx.storage` 保存，卸载 / reload 后保留；最近路由仅驻留内存。它们不包含凭证值、第二份 transcript、observer cursor 或待恢复决策。

`opencode-self-driving/rpc` 导出 `Contract`、`Status`、`Route`、`Resource`、`ResourceResult`、`ApprovalResult`、`Policies`、`Profile`、`Published` 和档位 schema。

## 资源与审批

profile 可选增加 `resources: { tauOmit }`，以及 `approval: { tauAllow, timeoutMs, maxBytes, maxTokens, mcpServers }`。阈值范围为 `[0, 1]`，预算与 deadline 必须是正整数，MCP server 名单非空；这些配置没有默认值。旧 profile 可继续使用 inherit / off。测试中的 `.1` / `.05` 是 fixture 数值，不是已校准的产品建议。

```js
await rpc("policies", {
  sessionID,
  contextSelection: "shadow", // inherit | shadow | select
  approval: "shadow", // off | shadow | auto
})
```

模式独立于选择组合模型。设置绑定当前 profile revision，reload 保留设置；重新发布使其回到 inherit / off，必须再次显式启用。`disable` 关闭两种策略并恢复原模型。最近资源 / 审批诊断仅保留在内存，不恢复旧分配或批准。当前审批需要本插件生成绑定提供可关联的最终请求视图；在其他模型或没有本次绑定时维持 ask。

资源只省略能可靠识别边界的完整单位。当前原生 API 没有统一来源 / 依赖信息，**AGENTS.md、原生 skill 目录与已加载正文、MCP 指令与工具、CodeMode 的 execute / 内部目录、未知块均整体保留**。不会按提示词标签、段落或工具名前缀猜测删除。原生 MCP / skills 的细粒度省略尚不支持。

其他插件可通过已有 `SystemPart.metadata` 显式贡献可选单位：

```js
event.system.push({
  type: "text",
  text: "Optional instructions for the probe tool.",
  metadata: {
    "self-driving/resource": {
      id: "plugin.example/probe",
      kind: "tool-bundle", // instruction | tool-bundle
      source: "plugin.example",
      required: false,
      dependencies: [], // 本批其他资源的精确 ID
      tools: ["example_probe"], // instruction 类型必须为空
    },
  },
})
```

这是本插件定义的 opt-in metadata 契约，不是 OpenCode 原生来源字段，也不是新的宿主 API。贡献插件负责准确声明完整边界和依赖；未经标注的内容不进入可选集合。工具必须与公开注册目录、本次定义对应，且 `codemode: false`、无 namespace；skill / execute 不接受省略。基础 system 的前两个位置不能贡献可选单位。重复 ID、重叠工具、缺失依赖、来源不匹配、部分答案或预算错误使整批回到完整视图。

每次主请求重建快照与内容版本，批量询问 `needed`；仅 `p(needed) < tauOmit` 且依赖闭包允许时省略。shadow 只记录提案。容量与选模针对最终所选视图重新计算；两阶段共享准备 deadline，过期则阻断。直接工具的省略同时受公开执行 hook、Core 本次工具定义检查和派发前工具集合检查约束。

审批只处理原生 ask。当前支持明确列入 `mcpServers`、无名称碰撞且 `codemode: false` 的直接 MCP 工具：核对公开工具 namespace、连接状态、source 的 message / call、原生 running invocation、原生 `metadata.input` 和克隆快照。读取完整原生可见 context，并包含原始指令、最终请求、cwd、用户限制、action / resources 和精确参数；不裁剪关键证据。只有 `p(needs_human) < tauAllow` 且 auto 模式才将 ask 改为 allow；shadow 仍 ask。

原生 deny 保持权威，原生 allow 不重复判断。shell 缺完整原生 command metadata、CodeMode 内部调用、未知 action、压缩后授权不完整、参数变动、超限、失败或独立审批超时均维持 ask。`lastApproval` 记录 `manual-required` 原因；没有公开 hasUI 检测，headless ask 可能等待客户端。后续权限 hook 仍可改写结论，这不是隔离其他插件的安全边界。

## 路由、容量与诊断

主请求先按完整所选视图及输出预算过滤容量。只有一个合格档位时不调用 Evaluation；多个档位使用原生 Choice，仅允许选择合格候选。失败、非法答案、超时或身份不匹配都阻断派发，无插件重试或换档 fallback。

原生返回的概率分布和 confidence 原样记录；不补造缺失字段，不设置通用 confidence 门槛。System One 必需分布与 Vercel 可选分布沿用各自原生契约；已声明舍入精度时按候选数计算求和容差，不归一化原值。

`bounded` 证据保留完整 system、所有可见用户约束、工具目录、当前完整 exchange，并从近到远加入其他完整 exchange，记录 view hash 和省略范围。不会截断单条消息、工具参数或 call / result 关系。`full` 超预算会失败，不隐式改成 bounded；两者均不修改生成历史。

资源与选模准备共享一个实际可取消的总 deadline，审批使用独立 deadline。每种决策发送前均核对真实序列化 HTTP body 的 bytes / 估算 tokens；`maxInputTokens` 应取服务每请求 / 每问题限制中较小的已验收值。批量资源问题还受完整请求预算约束，没有长上下文或问题数资格声明。生成发送前再次核对最终消息、工具、输出预算和绑定版本，并在实际 HTTP middleware 检查合并后的最终 JSON 的模型、输出与容量。后续 hook 扩大请求导致不再合格时会拒绝，不偷偷换模型。

组合窗口取同一有效物理配对的联合预算，并要求 compaction 配对覆盖它；小模型不拉低整个窗口。当前 `capacityEstimator` 为 `utf8-bytes`：把序列化请求 UTF-8 字节数作为保守 token 估算并加入显式余量，不使用阶段 0 fixture 的 bytes-per-token 常量。这不是精确 tokenizer 或端到端大窗口质量验收；真实模型校准属于阶段 5。

状态分别记录候选 / 排除原因、所选 tier、目录模型与请求物理模型、配置 / 容量 revision、决策请求 / 返回模型、概率、confidence、决策用量、生成后端用量和最近失败。错误记录包含用途与请求关联，不保留原始响应、请求 header 或凭证。生成物理身份是请求目标，不声称独立验证了返回身份。Core 的持久化模型仍是组合模型；其费用记录不能当成物理账单或节省成本证据。

title、compaction、Session generate 使用固定配对并单独复核；宿主辅助模型覆盖不会被静默替换。原生摘要、近期历史与 checkpoint 仍由 Core 处理。没有 Session 绑定的全局生成明确不支持。

## 生命周期与配置变更

主请求准备会先通过本插件的公开 RPC `checkpoint` 事件确认本地事件队列此前的内容已处理，再关联当前原生执行。原生事件的 `durable.seq` 仅在内存中用于过滤迟到 / 重复生命周期事件；不读 durable log，不把它当成逻辑请求 ID，不恢复事件 cursor。事件流结束或失败会取消插件拥有的工作并停止新调用，需 reload 插件恢复。

`preparationTimeoutMs` 从请求开始持续覆盖资源、选模及绑定交接，不逐阶段重置。交接给 Core 前未被消费的绑定也会到期释放，包括独立 Session generate 被后续 hook 阻塞、取消的情况。适配器返回零缓冲流，Core 首次读取时才结束准备计时；之后取消由 Core 的流和插件信号传至真实 HTTP。title 后台任务可以按原生行为在前台执行 idle 后完成；独立 generate 不依赖前台执行结束事件。

每次 context 重建都产生新绑定和新决策，包括 Core 的 retry。插件没有自己的 retry、生成 fallback 或旧绑定复用。新请求不会被旧结束事件取消，迟到的错误不会覆盖后续执行；steering 输入仍等待原生安全边界。

发布会串行处理，遍历公开 Session 分页，等待相关 Session idle 并排空插件请求。已开始的原生执行可继续按旧快照完成；变更期间的新执行在决策 / 生成前明确失败，调用方在更新完成后重试。输入准入与历史仍属于 Core，插件不删除输入或添加执行队列。发布前重查容量，刷新后核对公开 auto 模型的完整容量再保存配置；不匹配时恢复旧 profile / 目录，恢复仍失败则停止接入并要求 reload。

取消发布等待会保留旧 profile，当前模型调用继续运行。开始提交目录 / storage 后，取消 RPC 不保证撤销已提交的变更，应查询 config / status。公开 API 没有跨 Session 准入、catalog、storage 的原子事务。`configuration` RPC 事件提供 `applying` 状态；按 Session 查询的 `status.lifecycle` 显示活动准备、绑定、生成、审批、视图和工具关联，以及 Location 的可用状态、checkpoint / deadline 数量。

Location reload 遵循宿主已有的 scope 租约，可能等待旧执行结束；需要立即停止当前执行时，先使用原生 Session interrupt。插件 cleanup / host shutdown 会取消自身工作，释放未消费绑定、流、视图、事件订阅与计时器，不保证撤销已发生的外部工具动作或远端计费。Stateful observer、插件恢复与 exactly-once 仍不在本版范围内。

## 验证与产物

真实调用的计划、预算、凭证引用和指标口径见 [验收工具](qualification.md)。`qualify` 默认预检，只有显式 `--execute` 才发送模型请求；占位模型和零预算必须先填写。

`bun run check` 与离线安装、runtime import boundary、TUI 终端测试的方法见 [开发指南](development.md)。开发脚本 / SDK 不进入 runtime bundle；宿主共享 Effect、Solid 和 OpenTUI。

原始 `artifacts/`、`dist/` 和依赖不提交。用于 review 的精简合成计划、结果与脱敏小日志保存在 [evidence](evidence/README.md)，tarball 包含整个 `docs/`。历史阶段记录归档在 [archive](archive/README.md)。npm 发布、hosted CI、生产质量与插件恢复均无通过声明。
