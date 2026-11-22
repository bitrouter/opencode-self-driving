# 阶段 3：资源选择与自动审批

> 历史阶段快照：用例数量、版本和当时结论不代表当前状态。当前结果见 [验证总览](../validation/README.md)。未纳入 evidence 的原始日志和产物仅保留在本地。

`0.3.0-dev.0` 实现阶段 3 的公开 API MVP。本地协议与实现验证已通过；没有真实服务、概率校准、生产权限策略或已安装客户端资格声明。

## 交付与 review 入口

| 文件                                                         | 行为                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [resources.ts](../../src/resources.ts)                       | 按请求构造资源 manifest / 内容版本，原生 Boolean 批次、严格阈值、依赖闭包、shadow、原子选择与整批回退  |
| [approval.ts](../../src/approval.ts)                         | 直接 MCP 的精确 source / input / invocation 核对，完整授权证据、独立 Boolean 审批、保留原生 ask        |
| [server.ts](../../src/server.ts)                             | 共享准备 deadline、按选择后视图算容量、最终工具集合检查、执行 gate、单次审批关联、Session policies RPC |
| [config.ts](../../src/config.ts)、[rpc.ts](../../src/rpc.ts) | 显式阈值 / 预算 / server 名单，inherit / shadow / select、off / shadow / auto，资源与审批诊断          |
| [decisions.ts](../../src/decisions.ts)                       | 共用四种已有原生 Evaluation；保留 Choice 契约，批量 Boolean 不新增 transport 或服务                    |
| [README](../configuration.md)、[SPEC](../spec.md)            | 配置 / metadata 契约、支持边界和待 review 的实现选择                                                   |

配置仍是每 Location 一个已发布 profile。加载和选择 auto 模型不隐含资源裁剪或审批授权；`policies` 需按 Session 显式调用。开关绑定当前 profile revision：reload 保留设置，重新 publish 回到 inherit / off，disable 同时关闭。旧 profile 无新增字段时可继续使用。

`resources.tauOmit`、`approval.tauAllow` 范围为 `[0, 1]`，两种判断均严格 `<`。审批还需显式设置 `timeoutMs / maxBytes / maxTokens / mcpServers`，不存在产品默认阈值。测试的 `.1` / `.05` 只验证边界，不表示校准过的错误率。

## 资源支持集

资源单位通过现有 `SystemPart.metadata["self-driving/resource"]` 显式贡献，schema 导出为 `Resource`。这是本插件的 opt-in 数据契约，不是新的 OpenCode hook，也不是原生来源字段。贡献者声明完整边界、required 和 dependencies；插件从实际 block / tool 定义计算版本，并核对公开目录。只保留当前请求快照，不建立资源发现注册表或保存第二份 transcript。

- `instruction`：完整标注的 system block，tools 必须为空。
- `tool-bundle`：完整 block 加本次直接工具；必须无 namespace、`codemode: false`，与目录身份 / 描述相符。skill 和 execute 排除在可省略集合外。
- 未标注内容、基础 system、适用 AGENTS.md、原生 skill 目录 / 已加载正文、MCP 指令 / 工具、CodeMode execute / 内部目录均保留。
- 重复 ID、工具归属重叠、未知依赖、MCP / CodeMode 拆分尝试、非法 / 部分答案、超预算或失败，均整批保留完整视图。不会留下半份裁剪结果。
- 每次主请求重建快照与依赖闭包，先计算临时视图再算容量和选模，成功后提交。下游恢复已省略工具在实际派发前失败；模型猜测调用已省略工具不能执行。

**原生 MCP / skill 的细粒度省略尚不支持。** 当前公开 API 没有通用 instruction 来源、完整依赖和 CodeMode 叶子执行分配接口。这里的保留是实际支持边界；不把未裁剪的资源计为“已自动筛选”。贡献 metadata 也不是隔离不可信插件的安全机制。

资源 Boolean 与选模 Choice 最多两个串行阶段，共享 `preparationTimeoutMs` 和真实取消信号。资源失败后对完整视图重算容量；剩余时间不足时阻断。无可选问题时不调用资源 Evaluation，单个容量合格档位继续跳过选模 Evaluation。

## 审批支持集

只接管原生 ask；原生 deny 在本 hook 前保持权威，原生 allow 不重复判断。不改权限规则，不直接回复原生 ask 为 always，也不绕过 permission.assert。

当前 auto 只支持显式列入 `mcpServers`、名称映射唯一、连接正常、`codemode: false` 的直接 MCP 工具。绑定使用公开 namespace / 目录 ID，按已验收 2.0.32 的 MCP 命名约定核对 action。权限 resources 必须为该原生绑定的 `["*"]`。必须同时吻合：

1. tool.before 的克隆 input；
2. 原生 permission 的完整 `metadata.input`；
3. 公开 Session context 中 source 指向的 running assistant invocation；
4. 本次生成绑定的公开原生消息前缀、agent 与目录定义。

审批输入包含完整原生可见历史、原始请求指令 / 资源、最终实际请求、用户授权与限制、cwd、工具 / server、action / resources 和精确参数。按独立审批预算检查整个证据，再按共同决策预算检查实际 HTTP body；不截断、摘要或省略关键授权。每个 source / call 独立决策并消费一次关联，不复用成 Session 或工具级批准。诊断只留 source、概率、证据 hash 和静态原因，不保存原始参数、证据或凭证。

shadow 记录建议并保留 ask；auto 仅在 `p(needs_human) < tauAllow` 时设置 allow。阈值相等、非法答案、身份 / 参数不匹配、预算不足、超时或取消保留 ask。shell 不携带完整原生 command metadata，CodeMode 叶子调用无法与外层 invocation 对齐，因此当前均不自动批准。无本插件当前生成绑定时也 ask。

当前看到 native compaction 就保守维持 ask，包括之后有新输入的情况；不恢复不可见的旧授权。更细的授权覆盖判定留待 review。没有 hasUI 公开能力，headless ask 可能等待客户端；`lastApproval.outcome: manual-required` 与 reason 供调用方展示。后续 hook 仍可改变结论，插件之间不存在隔离边界。

## 基线与检查

- 日期：2026-10-18，macOS，Bun `1.4.2`。
- 验证宿主：OpenCode `2.0.32`，`501b15af26915ba52682e20e220e7e137e89e92f`。
- 主目录只修改 `opencode-self-driving/`；宿主源码、manifest、lockfile、Protocol / HttpApi / generated client 未改动。
- 测试通过离线安装的 tarball 和普通插件配置启动真实 SDK 宿主，使用隔离 HOME / XDG / 临时目录。HTTP / MCP 均为 loopback；只有测试 key，没有真实账户调用。

| 检查                    | 结果                                                                                         | 证据                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 包内 `bun run check`    | 类型检查、构建、声明与 **74 场景 / 229 断言**通过                                            | check.log（本地原始资料：`artifacts/0.3.0-dev.0/check.log`）、单轮 JUnit（本地原始资料：`artifacts/0.3.0-dev.0/single-results.xml`）    |
| 随机顺序复跑            | 10 轮，seed `237911`；**740 通过 / 0 失败 / 2,290 条断言**                                   | 日志（本地原始资料：`artifacts/0.3.0-dev.0/repeated-results.log`）、JUnit（本地原始资料：`artifacts/0.3.0-dev.0/repeated-results.xml`） |
| runtime import boundary | 100 inputs；禁止实现依赖 0，plugin / Effect external，无绝对开发路径                         | 审计（本地原始资料：`artifacts/0.3.0-dev.0/import-boundary.json`）                                                                      |
| 显式包 oxlint           | 24 个代码文件，0 warning / 0 error                                                           | 日志（本地原始资料：`artifacts/0.3.0-dev.0/package-lint.log`）                                                                          |
| 宿主根 `bun run check`  | 已安装依赖的验证 worktree：34 项 typecheck 成功（缓存），lint 0 error / 1,306 条既有 warning | 日志（本地原始资料：`artifacts/0.3.0-dev.0/host-check.log`）                                                                            |
| 离线 tarball            | 普通加载、可迁移安装、共享 Effect 与包回归通过                                               | 产物（本地原始资料：`artifacts/0.3.0-dev.0/opencode-self-driving-0.3.0-dev.0.tgz`）                                                     |

主 checkout 的宿主 oxlint 因既有开发依赖缺少 `@oxlint/plugins` 无法初始化；在依赖齐全的验证 worktree 完成宿主检查与显式包检查，未改主 checkout 依赖。记录见 环境日志（本地原始资料：`artifacts/0.3.0-dev.0/main-lint-environment.log`）。本包不在宿主 workspace glob 中，宿主 typecheck 不能替代包内检查。

## 新增验证覆盖

33 个新增场景保留阶段 2 的 41 个回归，共 74 个场景：

- 资源 inherit / shadow / select；通过原生配置显式加载的 AGENTS.md 指令、skill 工具入口、CodeMode 及未知指令均保留。
- 严格阈值、依赖闭包、required 跳过 Evaluation、动态 block 更新后重新决策；无旧分配复用。
- 缺失依赖、CodeMode / MCP 拆分、部分答案整批回退；完整视图回退后容量候选重新计算。
- 已省略工具的猜测调用不能执行；下游 hook 恢复工具在物理 HTTP 前阻断。
- 四种原生 Evaluation 的 Boolean 契约经过实际 HTTP，包含 System One noul 映射与 Vercel Boolean。
- 真实 loopback MCP initialize / list / call、原生权限 ask / allow / deny、off / shadow / auto、独立 Session 显式启用。
- 完整审批证据保留用户限制与精确 input；严格阈值相等仍 ask、两个独立调用分别决策。
- shell、原生 compaction、未列入名单的 server、无效概率、证据超限、下游工具参数改写回到 ask。
- 资源总准备 deadline 与独立审批 deadline 均取消真正等待的 HTTP，在 loopback 服务端观察到断开；没有用 Promise.race 代替取消。
- 配置 / 开关经 reload 保留、重新 publish 失效、disable 关闭；缺预算和越界阈值被拒绝。

MCP 工具目录更新存在宿主自己的异步注册流程。fixture 通过公开 tool transform 观察目录就绪后再开始场景，不使用 sleep、私有 flush 或内部 layer。原生 ask 的人工答复由测试事件消费者通过公开 permission.reply 完成，并单独统计 ask；它不是被测插件的自动放行路径。

完整资源来源与 UI、快速重启 / 延迟终止事件 / 全部取消竞争、真实服务及阈值质量仍分别属于后续阶段。Stateful observer 与插件恢复保持 defer；没有 hosted CI、发布或生产验收。

## 复跑

从本目录，用 Bun `1.4.2`：

```sh
bun run dev:link /path/to/qualified/opencode
bun run check
bun run test -- --rerun-each 10 --randomize --seed=237911
```

构建产物、开发依赖和 `artifacts/` 被 git 忽略。本阶段没有提交、发布或调用真实模型服务。
