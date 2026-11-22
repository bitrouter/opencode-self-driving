# 阶段 4：取消、并发与生命周期

> 历史阶段快照：用例数量、版本和当时结论不代表当前状态。当前结果见 [验证总览](../validation/README.md)。未纳入 evidence 的原始日志和产物仅保留在本地。

`0.4.0-dev.0` 实现阶段 4 的公开 API MVP。保留阶段 3 的资源选择与自动审批，补齐请求取消、有限交接、原生 retry、配置发布排空和本地清理。下面的结论来自隔离宿主与 loopback HTTP / MCP，未调用真实模型账户。

## 交付与 review 入口

| 文件                                                                                                       | 行为                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [lifecycle.ts](../../src/lifecycle.ts)                                                                     | 本地执行关联、事件 checkpoint、准备 / 交接 deadline、工作登记、排空与取消                        |
| [server.ts](../../src/server.ts)                                                                           | 事件与请求关联、独立审批取消、迟到结果检查、Step 视图释放、发布 gate / 排空 / 目录核对与失败补偿 |
| [bridge.ts](../../src/bridge.ts)                                                                           | 零缓冲流，Core 首次读取后才开始 native generation；取消传播至 HTTP                               |
| [rpc.ts](../../src/rpc.ts)                                                                                 | 本插件的 checkpoint / configuration 事件和可观察的 lifecycle 计数                                |
| [lifecycle.test.ts](../../test/lifecycle.test.ts)、[lifecycle-fixture.ts](../../test/lifecycle-fixture.ts) | 22 个新增场景，真实公开事件、SDK、原生请求和连接取消                                             |
| [README](../configuration.md)、[SPEC](../spec.md)                                                          | 当前行为、配置变更边界与后续范围                                                                 |

版本仍为 private。没有修改宿主 Core、Server、Protocol、HttpApi、生成客户端、manifest 或 lockfile，没有新增运行时依赖。

## 生命周期边界

主执行准备先发出本插件的公开 RPC checkpoint，确认同一本地事件队列已处理到该事件，再关联当前执行。原生事件的 `durable.seq` 用于忽略迟到或重复事件；关联对象完全在内存中，不是宿主的 execution ID、执行所有权或持久 cursor。事件流结束 / 失败会停止新调用并取消插件拥有的工作；需 reload 恢复，不自动重放。

一次 `preparationTimeoutMs` 从请求开始覆盖资源选择、容量计算、选模和未消费绑定的交接，不逐阶段重新计时。Core 首次读取零缓冲流才结束计时。独立 generate 即使在后续插件 hook 中阻塞、取消，未消费绑定也会在这个原 deadline 内释放；不另加隐藏的生成超时。进入流消费后，Core 的取消与插件信号传至 native HTTP。

原生后台 title 的流可在前台执行 idle 后继续完成；独立 Session generate 由自己的流和调用方取消控制，不依赖前台执行结束。主请求 / 审批只受其关联执行的终止影响，一个 Session 中断不取消另一个 Session。迟到错误核对最新请求和执行关联后才写诊断。

每次原生 context 重建都生成新绑定并重新决策，包括 Core retry。插件不增加 retry 或 generation fallback，也不复用旧传输绑定。steering 输入继续等待原生安全边界，不隐式中断当前请求。

完整审批 / 资源视图只保留至相应 Step 的工具结算；Step ended / failed 和执行终止负责清理。正常完成、失败、取消、未消费到期、cleanup 均释放工作记录。少量最近诊断和每 Session 的序号关联留到插件卸载，不保存第二份 transcript 或 stateful observer。

Location reload 遵循宿主已有 scope 租约，可能等待执行结束。测试验证的是“请求 reload 后原生 interrupt”以及 host shutdown，不能据此声称 reload 请求本身总会立即断开 HTTP。需要立即停止时使用原生 Session interrupt。cleanup 取消插件工作，释放绑定、流、视图、工具关联、订阅与计时器；远端执行、已发生的工具动作与计费不具备回滚保证。

## 配置发布与取消

控制操作串行执行。发布先验证凭证引用和容量，通过 checkpoint 关闭新请求接入，再遍历公开 Session 分页等待相关执行 idle，并排空后台 title / 独立 generate 等工作。已有执行继续使用旧 profile 快照；变更窗口内新执行在插件决策 / 生成前失败，调用方在完成后重试。原生输入准入与历史仍属于 Core，插件不删除已准入输入或新增执行队列。

排空后重新计算容量，刷新 provider，核对公开 auto 模型的 enabled、input / context / output，再保存 published storage。测试发现其他插件的 provider transform 失败会被宿主隔离，`provider.reload()` 返回成功本身不能证明目录符合预期；因此必须核对实际公开目录。目录不匹配或保存失败时恢复旧内存 profile 与目录，恢复失败则停止接入并要求 reload。

取消发布等待会保留旧 profile、重新开放接入，正在运行的模型不被隐式 interrupt。Promise API 的 `session.wait` 不转交本次 RPC 的取消信号，因此取消的是插件的等待和写入意图；宿主内部 wait 仍在 Session idle 时完成。进入 catalog / storage 提交后，取消 RPC 不保证撤销，调用方应查询 config / status。公开 API 没有跨 Session admission、catalog 和 storage 的联合事务。

`configuration` 事件报告 applying。按 Session 查询的 `status.lifecycle` 报告 preparing / pending / streaming / approval、视图与工具关联数量；available / applying、checkpoint / deadline 数量属于 Location。公开 RPC 错误会被宿主收敛为通用失败，不依赖客户端收到内部错误文本来确认补偿，使用 config / status 与后续可用请求核对。

## 验证基线

- 日期：2026-10-18，macOS，Bun `1.4.2`。
- 验证宿主：OpenCode `2.0.32`，`501b15af26915ba52682e20e220e7e137e89e92f`。
- 主 checkout：`60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006`；只新增 / 修改 `opencode-self-driving/`，保留其余工作。
- 通过离线 tarball、普通插件配置和真实 SDK 启动隔离 HOME / XDG / 临时目录宿主；HTTP / MCP 与 key 都是本地 fixture。

| 检查                    | 结果                                                                                       | 证据                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 包内 `bun run check`    | 类型检查、构建、声明与 **96 场景 / 304 断言**通过                                          | 日志（本地原始资料：`artifacts/0.4.0-dev.0/check.log`）、单轮 JUnit（本地原始资料：`artifacts/0.4.0-dev.0/single-results.xml`）         |
| 随机顺序复跑            | 10 轮，seed `237911`；**960 通过 / 0 失败 / 3,040 条断言**                                 | 日志（本地原始资料：`artifacts/0.4.0-dev.0/repeated-results.log`）、JUnit（本地原始资料：`artifacts/0.4.0-dev.0/repeated-results.xml`） |
| runtime import boundary | 101 inputs，禁止实现依赖 0；plugin / Effect external，无绝对开发路径                       | 审计（本地原始资料：`artifacts/0.4.0-dev.0/import-boundary.json`）                                                                      |
| 显式包 oxlint           | 27 个代码文件，0 warning / 0 error                                                         | 日志（本地原始资料：`artifacts/0.4.0-dev.0/package-lint.log`）                                                                          |
| 宿主根 `bun run check`  | 依赖齐全的验证 worktree：34 项 typecheck 成功（缓存），lint 0 error / 1,306 条既有 warning | 日志（本地原始资料：`artifacts/0.4.0-dev.0/host-check.log`）                                                                            |
| 离线 tarball            | 普通加载、可迁移安装与共享 Effect 回归通过                                                 | 产物（本地原始资料：`artifacts/0.4.0-dev.0/opencode-self-driving-0.4.0-dev.0.tgz`）                                                     |

主 checkout 宿主检查仍受既有 `@oxlint/plugins` 缺失影响；使用已安装依赖的验证 worktree 完成宿主 / 显式包检查，未修改依赖。本包在宿主 workspace glob 外，根目录 typecheck 不能替代包内检查。宿主基线和构建方法沿用 [阶段 3](phase-3-validation.md)。

## 新增验证覆盖

阶段 3 的 74 个场景保留，新增 22 个场景：

- 迟到 / 重复执行终止不能取消新执行；checkpoint 取消、事件流丢失与取消 drain 释放等待，不误停已有工作。这三个状态协议场景直接测试实际 Lifecycle 实现。
- 路由决策、资源决策、独立审批、生成响应头前与输出中途的取消，均在 loopback 服务端观察到实际连接断开；取消的审批不会迟到 allow。
- 成功完成与准备失败后记录释放；原生 503 retry 重建 context、再次决策并使用新绑定。fixture 仅用公开 retry hook 将测试退避设为零，插件没有自己的 retry。
- 中断后立即提交新输入、两个 Session 并发、steering 等待原生边界。
- 准备期间请求 reload 再显式原生 interrupt；host shutdown；取消使用 30 秒准备 deadline 的请求，证明实际取消未依赖短超时。
- 独立 generate 的调用方取消；后台 title 晚于前台 idle 完成。
- 发布排空旧请求、变更窗口拒绝新执行、新 revision 使用新输出预算；取消发布等待保留旧配置和旧请求。
- 另一公开 generate hook 阻塞后调用方取消，未消费绑定按原准备 deadline 到期，发布继续；没有物理生成请求、轮询或 sleep。
- 原生 integration key 轮换后下次请求使用新 key，诊断不暴露秘密。
- 另一公开 provider transform 一次性移除 auto 模型造成目录不匹配，发布失败后恢复旧 revision / 目录；旧预算下的实际请求仍可用。

其余集成场景使用实际公开 SDK / 插件宿主、事件与 HTTP，不模拟宿主内部层。测试 consumer 通过公开事件 / RPC 协调边界，不读取私有 Session 存储。

## 复跑与后续范围

从本目录，用 Bun `1.4.2`：

```sh
bun run dev:link /path/to/qualified/opencode
bun run check
bun run test -- --rerun-each 10 --randomize --seed=237911
```

真实服务、tokenizer / 概率校准 / 阈值质量仍属于阶段 5，TUI / 已安装客户端属于阶段 6。Stateful observer、插件恢复、集群与 exactly-once 保持 defer。本阶段没有提交、发布或 hosted CI 结果；`dist`、开发依赖和本地证据继续被 git 忽略。
