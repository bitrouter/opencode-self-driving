# 阶段 5：验收工具与真实接入状态

> 历史阶段快照：用例数量、版本和当时结论不代表当前状态。当前结果见 [验证总览](../validation/README.md)。未纳入 evidence 的原始日志和产物仅保留在本地。

后续更新：`0.6.0-dev.0` 已使用真实 OpenRouter key 完成部分接入验证；8 次模型请求均 HTTP 200，文本样本一例失败，MCP 经一次预授权回复续步成功。详见 [OpenRouter 实测](../validation/openrouter-live.md)。以下保留 `0.5.0-dev.0` 阶段的原始记录。

当前包为 `0.5.0-dev.0`，private。**有界接入验收工具已实现并通过本地 SDK / loopback 验证；真实 provider 接入和质量资格尚未验收。** 缺少用户选定的服务、固定模型、凭证引用与 live 调用预算，没有用 fixture 代替这些结果。

## 交付与 review 入口

| 文件                                                                                    | 行为                                                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [qualify.ts](../../script/qualify.ts)                                                   | 显式计划 / 新报告路径、默认预检、隔离子进程、白名单环境与总 deadline                                    |
| [plan.ts](../../script/qualification/plan.ts)                                           | 既有 profile、全部显式预算、endpoint / 凭证引用、预先标注样本、tuning / holdout 重复输入检查            |
| [egress.ts](../../script/qualification/egress.ts)                                       | 转发原生已序列化请求、并发共享预算、模型身份 / 输出限制、取消、redirect 阻断、无原始 body / header 记录 |
| [run.ts](../../script/qualification/run.ts)                                             | 真实 SDK 加载正式插件，原生目录预检 / 配置 / Session / 工具续步，静态 MCP 与人工分支计数                |
| [metrics.ts](../../script/qualification/metrics.ts)                                     | 按 split 的完成标签、路由标签、资源省略、审批漏检 / 覆盖 / 人工比例；空分母保留 null                    |
| [qualification.test.ts](../../test/qualification.test.ts)                               | 20 个新增场景，包含真实隔离 CLI 子进程和原生 SDK / HTTP / MCP                                           |
| [docs/qualification.md](../qualification.md)、[模板](../../examples/qualification.json) | 运行方法、完整字段与指标口径、预算和资格边界                                                            |

阶段 4 的插件 runtime 实现保持不变，仅更新包版本和文档。没有新增 DecisionAdapter、BackendAdapter、凭证方式或运行时依赖；SDK 仍是开发依赖，验收脚本不进入 runtime bundle。没有 Core、Server、Protocol、HttpApi、生成客户端或宿主 lockfile 改动。

## 真实接入的当前状态

| 项目                 | 本轮证据                                                                                        | 状态                                                |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 公开原生模型目录     | 原生 OpenRouter `openai/gpt-4o-mini` 的静态定义用于本地探针；未改写能力 / 容量                  | 本地目录预检通过，不代表该模型已在远端调用          |
| 原生 OpenAI 默认配置 | 当前 V2 默认 transport / native compaction 不在已有 HTTP + summary 绑定支持集，预检在发送前拒绝 | 明确未支持该默认组合，未静默改写                    |
| 凭证可用性           | 当前进程没有模型 API key；零调用预检缺少 `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`              | blocked；这些名称只是元数据预检引用，非最终服务选择 |
| 真实模型调用         | 本轮仅 loopback / 合成 key，provider HTTP 请求数为 0                                            | 未验收                                              |
| 概率、阈值和编码质量 | 有指标工具和固定标签入口，没有代表性真实数据                                                    | `not-qualified`                                     |
| tokenizer / 长窗口   | 仍为 UTF-8 bytes 保守容量估算，未运行真实长窗口边界                                             | 未验收                                              |
| 已安装客户端         | 本机 `opencode --version` 为 `1.18.3`，不同于验收的 V2 开发宿主                                 | 未修改；TUI / 安装兼容留阶段 6                      |

零调用预检证据：报告（本地原始资料：`artifacts/0.5.0-dev.0/credential-preflight.json`）、元数据计划（本地原始资料：`artifacts/0.5.0-dev.0/credential-preflight-plan.json`）。该计划没有 `--execute` 授权，Evaluation model 仍是待选择占位符；它只验证工具能在缺凭证时阻止调用，不能当成已通过的 provider profile。

## 行为与边界

每次运行加载构建后的正式插件，通过已有 `draft / publish / enable / policies / status` RPC 控制。独立父进程仅转交计划引用的 key 环境变量；临时 HOME / XDG / config / database、禁用项目配置 / models fetch / watcher，原生 credential.create 只写本次临时宿主。预检先完成普通插件加载，再读取同一 Location 的 model / provider 目录，核对实际配对生效的 relay 地址。

预算覆盖全部模型请求，包含资源、选模、独立审批、生成及辅助请求；并发发起也共用请求 / 输入字节额度。原生 Evaluation 没有统一输出 token cap；生成受 maxOutputTokens，决策受请求数 / 输入 / 响应 / 总时长。响应限制在接收到 chunk 后检测，可能超过一个 chunk，不能撤销远端生成或费用。父进程清理宽限最多 5 秒，不增加新调用授权。没有金额或远端停止保证。

工具目录与原生权限只允许本地静态 echo 探针。人工 ask 的 consumer 对预先标注正例的精确 action / input 回复 once，其余 reject；单独计入 manualReplies，不算插件 auto allow。原生工具结果继续由 Core 驱动下一 Step。原生 retry 被本次验收宿主关闭，失败后不自动付费重跑；正式插件的资源 / 审批保守回退仍保留并受共同预算约束。

报告保留公开路由与已报告用量、请求 status / 字节 / 耗时、工具匹配、原生 Step 与 split 指标。不保存凭证、header、原始 prompt / output / tool input、上游错误 body 或原始 log。没有观察的分母为零时用 null，未知用量不补零。profile / 标签 / 阈值在计划中预先固定，写入 planHash；tuning 与 holdout 不合并，不自动调阈值。

`completed` 只意味着计划中的探针完成；精确文本 / echo 与路由标签不能替代实际编码完成质量。概率 / 质量状态始终为 not-qualified，最终资格仍须独立代表性数据、冻结阈值及人工 review。这里的 live event 收集只服务本次隔离验收，不是 runtime stateful observer、durable replay 或插件恢复。

## 本地检查

- 日期：2026-10-18，macOS，Bun `1.4.2`。
- 验证宿主：OpenCode `2.0.32`，`501b15af26915ba52682e20e220e7e137e89e92f`。
- 主 checkout：`60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006`；修改范围仍为 `opencode-self-driving/`。
- 离线安装 tarball、普通插件配置、真实 SDK / loopback HTTP / MCP、合成 key；没有真实账户调用、提交、发布或 hosted CI。

| 检查                    | 结果                                                                                       | 证据                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 包内 `bun run check`    | 类型检查、构建、声明与 **116 场景 / 389 断言**通过                                         | 日志（本地原始资料：`artifacts/0.5.0-dev.0/check.log`）、单轮 JUnit（本地原始资料：`artifacts/0.5.0-dev.0/single-results.xml`）         |
| 随机顺序复跑            | 10 轮，seed `237911`；**1,160 通过 / 0 失败 / 3,890 条断言**                               | 日志（本地原始资料：`artifacts/0.5.0-dev.0/repeated-results.log`）、JUnit（本地原始资料：`artifacts/0.5.0-dev.0/repeated-results.xml`） |
| runtime import boundary | 101 inputs、禁止实现依赖 0；SDK / 开发工具未进入 bundle，Effect 单实例与迁移安装回归通过   | 审计（本地原始资料：`artifacts/0.5.0-dev.0/import-boundary.json`）                                                                      |
| 显式包 oxlint           | 34 个代码文件，0 warning / 0 error                                                         | 日志（本地原始资料：`artifacts/0.5.0-dev.0/package-lint.log`）                                                                          |
| 宿主根 `bun run check`  | 依赖齐全的验证 worktree：34 项 typecheck 成功（缓存），lint 0 error / 1,306 条既有 warning | 日志（本地原始资料：`artifacts/0.5.0-dev.0/host-check.log`）                                                                            |
| 离线 tarball            | 正常加载与包回归通过，保持 private                                                         | 产物（本地原始资料：`artifacts/0.5.0-dev.0/opencode-self-driving-0.5.0-dev.0.tgz`）                                                     |

主 checkout 的宿主 oxlint 仍缺少既有 `@oxlint/plugins`；本轮同样在依赖齐全的验证 worktree 完成宿主与显式包检查，没有修补主目录依赖。本包在宿主 workspace glob 外，根 typecheck 不能替代包内检查。

新增 20 个场景保留阶段 4 的 96 个回归，验证：计划和数据 split、零调用预检、并发请求额度、输出 / 模型 / 输入 / 响应限制、redirect、不补零的指标、原生目录 / 路由 / 用量、401 无重试、资源选择 / MCP shadow 与 auto / 下一 Step、原生 integration 导入、缺 key、取消、默认 OpenAI 组合拒绝，以及 CLI 子进程隔离 / 预检 / 执行 / 报告防覆盖。

## 下一步

用户指定 DecisionAdapter / BackendAdapter、固定模型与可接受 response model、现有 key 的 env / integration 引用，以及请求数 / 输出 / 总时间 / 字节预算后，先完成 preflight，再执行一个明确计划。真实调用的成功、失败和停止原因原样作为结果，不自动更换服务或修改阈值。代表性编码、负例审批、资源必要性、full / bounded、tokenizer 和长窗口的数据方案仍须单独 review；Stateful observer 与插件恢复继续 defer。
