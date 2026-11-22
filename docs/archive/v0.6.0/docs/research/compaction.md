# 压缩接管调查

日期：2026-10-18。状态：源码调查和隔离验证完成；尚未实现正式插件。

后续设计已更新到 [docs/spec.md](../spec.md)：MVP 采用“最大可承接窗口＋逐请求容量过滤＋保留原生压缩”。以下 A—D 保留为压缩接管调查记录，不代表当前实施选择；最大窗口方案仍待专项验证。

## 结论

严格只使用公开插件 API，可以由插件决定每次实际发送给模型的上下文、何时生成摘要，以及如何保存和重建派生摘要。也可以通过组合模型和公开 Session 控制项，安排原生 checkpoint 在真实模型调用前完成。

现有 API 不支持透明替换整个原生压缩机制：没有逐 Session 的自动压缩开关，没有触发判断前的压缩策略 hook，没有正常跳过本次压缩的返回值，也没有自定义历史切分和直接提交 checkpoint 的公开接口。

因此有三种不同的接管目标：

| 目标                                             | 结论                | 必须承认的条件                                                        |
| ------------------------------------------------ | ------------------- | --------------------------------------------------------------------- |
| 自管发给模型的上下文和摘要                       | 可行，已做局部验证  | 需要防止原生自动压缩先改变输入，并自行管理预算和派生状态              |
| 使用原生持久化，自定义摘要                       | 可行，已验证        | 触发、保留近期历史、checkpoint 发布和恢复仍由 Core 管理               |
| 保持原有执行语义，完全替换原生压缩调度和历史边界 | 公开插件 API 不完整 | 下面的控制适配可以补部分功能，但会增加 Step、synthetic 输入或执行中断 |

这里的“可行”指已经验证公开接入路径，不代表摘要质量、任意 provider、崩溃恢复或产品兼容性已经合格。

## 核对的源码版本

- 工作区和验证 worktree 基线：`60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006`。
- 调查中 fetch 后的 `origin/dev`：`501b15af26915ba52682e20e220e7e137e89e92f`。
- 两者之间 `packages/plugin`、`packages/core/src/session`、压缩配置 schema 和压缩配置插件没有差异。
- 结论针对当前 V2 源码，不声称其他已发布版本的插件 API 一致。

## 原生顺序与公开入口

主请求的顺序是：加载原生上下文 → 检查自动压缩 → 必要时完成压缩并重建上下文 → `session.context` → `llm.stream`。因此，主请求的 context hook 无法阻止已经发生的自动压缩判断。[runner](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/session/runner/llm.ts#L218)

`session.compaction` 可以修改 system、messages、tools 和 options；提供 `result.summary` 会跳过默认摘要模型调用。返回内容由 Core 发布为原生压缩结果。[公开类型](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/plugin/src/promise/session.ts#L38)、[结果接收](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/session/compaction.ts#L600)

它有三个重要限制：

1. hook 没有本次触发原因、skip、cancel 或保留历史边界的独立字段。
2. 文本摘要路径先切分 older/recent，再调用 hook；近期内容仍由 Core 保留。`keep.tokens: 0` 也不保证清空近期内容，切分会保护最新 exchange。
3. 默认摘要指令在 hook 后追加；若要完全自定义摘要格式和生成算法，应提供 `result`。[摘要路径](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/session/compaction.ts#L272)、[历史切分](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/session/compaction.ts#L708)

公开的 `ctx.session.compact()` 提交 inbox 控制项。返回表示已经准入，不表示压缩完成。[准入](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/session/session.ts#L246)

`compaction.auto`、`buffer`、`keep.tokens` 来自宿主配置。设置 `auto: false` 同时关闭主动阈值压缩和 overflow 后的自动压缩；手动控制项仍可执行。这份状态是 Location 级策略。[配置](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/schema/src/config/compaction.ts)、[开关判断](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/session/compaction.ts#L205)

源码中的 `SessionCompaction.Service.transform` 是 Core 内部服务。Promise 和 Effect 的公开插件 Context 均没有暴露该服务或压缩配置 domain；不能因为内置插件用了它，就把它当作外部插件 API。[公开 Context](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/plugin/src/promise/plugin.ts#L26)、[内置配置插件](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/config/plugin/compaction.ts)

## 路径 A：保留原生历史，自管请求视图

这是可行的自管请求视图路径，当前 MVP 不采用。

前提是用户在明确管理的 Location 中设置 `compaction.auto: false`。插件在每次 context hook 中：

1. 观察宿主当前的 model-visible history 和可见资源。
2. 根据真实模型预算选择资源；必要时等待自定义摘要完成。
3. 保存摘要、来源指纹和策略版本等派生状态。
4. 修改本次 system/messages/tools，并按压缩后的输入设置输出预算。
5. 让 Core 正常执行模型、工具和持久化。

该 hook 是可等待的，所以能保证自己的异步摘要先于本次后端调用完成。原始历史仍由宿主保存。由于原生输出预算可能根据修改前的上下文计算，插件必须检查并在需要时覆盖 `options.maxTokens`。[请求准备](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/session/model-request.ts#L251)

验证覆盖：大输入被投影为短请求，原生历史保持原文；派生状态经正常关闭重开后仍可读取；revert 后重建视图、fork 使用独立 Session 存储键；不同 Session 的异步准备可以并行；投影后真实工具调用和结果仍保持 ID 配对。

测试摘要使用固定文本，仅证明执行顺序和状态边界。它没有证明语义保真。正式实现应保存摘要与来源引用，不建立第二份权威 transcript。

这一模式的成本：原生历史会持续增长，加载和转换历史的成本仍存在；关闭自动压缩会影响该 Location 的其他 Session；用户主动压缩仍需单独处理；还必须覆盖 compaction/generate/title 等入口各自的策略。

## 路径 B：组合模型自己管理容量

公开 Model 定义支持未知窗口：`limit.input` 和 `limit.context` 都为 0 时，Core 的主动压缩上限为 Infinity。[窗口计算](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/session/compaction.ts#L911)

这可以把预算责任交给 `self-driving/auto`，同时不关闭 Location 中其他模型的自动压缩。但是：

- 0 表示未知，不是无限。组合模型必须真正承担所选物理模型的输入、输出和模态检查。
- 仅设置未知窗口不够。物理模型的 overflow 如果传给 Core，仍会触发原生 overflow 压缩。
- 适配器可以在尚未产生响应或副作用时处理拒绝、重新投影并重发。验证中，两次模拟物理尝试由一个原生 Step 承载，没有产生原生 compaction。
- 该验证只覆盖模型返回响应前失败；流中错误、取消、重试预算和不同 provider 的错误识别尚未验证。
- 原生 UI 的容量信息、输出预算和估算会失去固定窗口依据。用户主动压缩也仍由原生调度。

这是符合公开 API 的候选设计，不应通过填写一个虚假的巨大窗口来实现。它把全部容量责任交给插件；当前 MVP 选择有限的最大可承接窗口，未采用这一未知窗口方案。

## 路径 C：保留原生 checkpoint，自定义摘要

当 Core 决定压缩时，在 `session.compaction` 中生成自己的摘要并设置 `result`。该路径已经验证会生成原生 checkpoint，并进入后续模型请求。

它适合只更换摘要策略：例如保护用户目标、未完成工具调用、必需指令和资源引用。触发策略、近期历史保留及持久化发布仍属于宿主。不能把 `result.summary` 当成一个通用“替换全部历史”的接口。

本轮验证使用文本摘要，没有验证 provider 原生的不透明压缩状态。后者有 endpoint/provenance 约束，不应跨物理模型随意重放。

## 路径 D：用公开 API 适配原生调度

确实找到了一条能在真实模型调用前完成原生 checkpoint 的路径：

1. 在 context hook 中准入 `compact` 控制项和一个继续执行的 synthetic 输入，并在本次 options 标记让出执行。
2. 组合模型适配器观察标记，返回一个无正文的完成流，不调用真实模型。
3. runner 完成当前 Step，在下一边界处理压缩控制项。
4. 压缩 hook 提供自定义摘要；随后 synthetic 输入被交付，runner 再准备请求并调用真实模型。

实际验证顺序：`virtual empty Step → compaction → physical call`。真实调用看到了自定义 checkpoint。

这意味着“公开 API 绝对无法安排先压缩再调用”这个说法过强。可以实现，但有可观察的代价：

- 多出一条原生 Step 记录和一条 model-visible synthetic 输入。
- synthetic 的交付会参与原生输入和 agent 步数预算语义。
- 需要处理两个控制项的准入、用户插入的新指令、中断、move、插件重载，以及在各阶段崩溃的恢复。
- 生产实现必须如实记录虚拟空 Step 的用量；本轮 fixture 使用固定模拟 usage，没有验证真实计费。

目前它是兼容性适配的可行性证明，不应作为已经合格的生产调度器。

另有更窄的直接路径：在空闲 Session 的 `session.prompt` hook 中提交压缩并等待 Session idle，再允许新输入准入，已验证顺序正确。它只覆盖输入准入边界，不能单独解决工具循环内的每个 Step。

## 已排除的捷径

| 尝试                                                         | 实际结果                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 在主请求 context hook 内提交 compact，然后正常返回           | 当前物理请求先执行，压缩在下一边界执行                                                       |
| 在 compaction hook 中抛错来拒绝压缩                          | 执行失败，没有“跳过压缩后继续”                                                               |
| compact 后 interrupt，并设置 resume                          | 排队压缩可执行，但原输入不会因此自动继续回答                                                 |
| 只把组合模型 input/context 设为未知                          | 避开主动阈值压缩，不能避开 provider overflow 触发的压缩                                      |
| 在活跃 context hook 中提交 compact 后等待同一个 Session idle | 当前 hook 属于正在等待完成的执行，不能作为同步压缩屏障；这是调用关系判断，未加入会挂起的测试 |
| 外部插件调用内置压缩配置服务                                 | 依赖 Core 内部服务，不符合本项目公开 API 限制                                                |

## 实际验证证据

验证代码保存在现有隔离 worktree 的 verification/compaction（本地验证材料：`packages/sdk/verification/compaction/validation.test.ts`，未入库）。插件接入代码在 plugin.ts（本地验证材料：`packages/sdk/verification/compaction/plugin.ts`，未入库），宿主使用公开 SDK 创建真实 Session，不替换 Core 服务。

14 个场景覆盖：原生先行压缩、自定义结果落盘、context 内准入顺序、中断恢复局限、hook 拒绝、auto 开关两种 overflow 行为、派生视图重启、未知窗口、空闲 prompt 屏障、真实工具配对、空 Step 控制适配、适配器内 overflow 恢复、revert/fork、并发 Session。

使用 Bun 1.4.2，随机顺序、固定 seed 237911，每场景重复 10 次。运行器使用隔离 HOME/XDG、临时数据库、关闭模型目录联网，不转发真实模型凭证。运行命令从 `packages/sdk` 执行：

```sh
bun run verification/compaction/run.ts --rerun-each 10 --randomize --seed 237911
```

最终结果：140 次运行通过、0 失败、580 条断言；SDK `bun typecheck` 通过；根目录 `bun run check` 通过，34 个类型检查任务成功。插件模块 bundle 的 50 个运行时输入中没有 Core、Server 或 SDK 的内部源码，Effect 保持外部依赖。原始证据：results.log（本地验证材料：`packages/sdk/verification/compaction/results.log`，未入库）、results.xml（本地验证材料：`packages/sdk/verification/compaction/results.xml`，未入库）、运行时 import 检查（本地验证材料：`packages/sdk/verification/compaction/import-boundary.json`，未入库）、完整检查日志（本地验证材料，未入库）。

未覆盖：真实模型摘要质量和计费、SIGKILL 中断的摘要与恢复、热重载、原生不透明 checkpoint、图片/音频、其他插件后续改写，以及真实 MCP/skills/AGENTS.md 资源适配。本报告只证明压缩控制路径，不能替代完整上下文管理的后续验证。

## 对 spec 的建议

把“管理完整上下文”定义为整个 Session 生命周期中的请求视图和资源策略，而把原生历史与 checkpoint 的接管程度独立列出。

后续讨论已选择另一条 MVP 路径：组合模型声明经过验证的最大可承接窗口，先按每次请求预算过滤候选档位，再路由到物理模型；压缩继续由 Core 管理。它不关闭 Location 自动压缩，不让小窗口后端拉低整个模型池的阈值，也不把声明窗口设为未知。具体约束和待验收项以 [docs/spec.md](../spec.md) 为准。

路径 A、未知窗口的 B 和控制适配的 D 留作调查备选。路径 C 中的自定义摘要结果不是 MVP 的默认行为；当前方案保留原生文本摘要与 checkpoint。已有实验结果不等于最大窗口、候选过滤和长上下文摘要的端到端验证。

若产品要求同时满足“逐 Session、保留准确的固定模型容量、每个 Step 在发送前可决定压缩、没有额外消息或空 Step、自定义持久化历史边界”，当前公开插件 API 无法完整提供。这个更强目标需要新的公开 hook 或宿主能力；本项目当前约束下不修改 Core 来补齐。
