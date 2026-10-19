# 阶段 0 / 0.1 验证报告

> 历史阶段快照：用例数量、版本和当时结论不代表当前状态。当前结果见 [验证总览](../validation/README.md)。未纳入 evidence 的原始日志和产物仅保留在本地。

状态：**阶段 0 / 0.1 本地 fixture 验证通过**。本报告记录当时的验证范围；后续阶段 1 的正式包骨架已完成，见 [docs/archive/phase-1-validation.md](phase-1-validation.md)。本轮没有调用付费模型，没有启用自动工具审批，没有修改 Core、Server、Protocol 或生成客户端，也没有连接或替换已安装的 OpenCode 服务。

## 基线与交付

- 日期：2026-10-18，macOS，Bun `1.4.2`，OpenCode `2.0.32`。
- 验证 worktree：`<qualified-opencode-checkout>`，分支 `plugin-routing-proof`。
- 在保留已有验证文件的前提下，将该 worktree 从 `60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006` 快进到最新 `origin/dev`：`501b15af26915ba52682e20e220e7e137e89e92f`。主目录没有快进或修改宿主代码。
- 新容量原型与集成验证位于 capacity 目录（本地验证材料：`packages/sdk/verification/capacity/README.md`，未入库），仍是隔离验证材料，不是可发布实现。

主要文件：容量策略（本地验证材料：`packages/sdk/verification/capacity/policy.ts`，未入库）、公开插件原型（本地验证材料：`packages/sdk/verification/capacity/plugin.ts`，未入库）、集成测试（本地验证材料：`packages/sdk/verification/capacity/validation.test.ts`，未入库）、隔离 runner（本地验证材料：`packages/sdk/verification/capacity/run.ts`，未入库）、依赖审计（本地验证材料：`packages/sdk/verification/capacity/audit.ts`，未入库）。SDK 只出现在验证宿主，插件 runtime 不导入 SDK / Core / Server。

## 结果

| 范围                       | 本轮结果                                                                   | 证据                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段 0：组合模型接入与路由 | 10 通过，0 失败，40 条断言                                                 | 日志（本地验证材料：`packages/sdk/verification/self-driving/results.log`，未入库）、JUnit（本地验证材料：`packages/sdk/verification/self-driving/results.xml`，未入库） |
| 独立压缩调查回归           | 14 通过，0 失败，58 条断言                                                 | 日志（本地验证材料：`packages/sdk/verification/compaction/results.log`，未入库）、JUnit（本地验证材料：`packages/sdk/verification/compaction/results.xml`，未入库）     |
| 阶段 0.1：容量链路         | 26 场景，随机顺序重复 10 轮；260 通过、0 失败、1,310 条断言                | 日志（本地验证材料：`packages/sdk/verification/capacity/results.log`，未入库）、JUnit（本地验证材料：`packages/sdk/verification/capacity/results.xml`，未入库）         |
| 运行时依赖边界             | 98 inputs，禁止依赖 0，Effect external                                     | 审计 JSON（本地验证材料：`packages/sdk/verification/capacity/import-boundary.json`，未入库）                                                                            |
| SDK typecheck              | 通过                                                                       | 从 `packages/sdk` 执行 `bun typecheck`                                                                                                                                  |
| 根目录规范检查             | `bun run check` 通过；34 项 typecheck，0 lint errors、1,306 条既有 warning | 完整日志（本地验证材料，未入库）                                                                                                                                        |

随机种子为 `237911`。计数区分本轮重跑与历史验证，不能把之前的 140 次压缩重复结果当成本轮新增证据。

## 阶段 0.1 的关键证据

| 设计要求       | 验证结果                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 最大可承接窗口 | 配置由同一个合格后端支撑 input/context/output 联合预算；添加小窗口配对不降低声明；未知窗口、不兼容输出或过小摘要配对在配置时失败 |
| 本次候选过滤   | 128K / 256K / 1M fixture 池中，80K 请求可选五档，200K 可选 high/xhigh/max，500K 只有 max；分类器不能选回已排除档位               |
| 单候选         | 500K 请求直接绑定 max，不调用分类器，不伪造 confidence 或决策用量；仍执行发送前预算检查                                          |
| 最终请求复核   | 后续 hook 增大 system、messages、tools 或改变输出预算时，在调用物理后端前失败；不换档、不调 fallback                             |
| 原生压缩阈值   | 500K 不因 128K 成员触发压缩；930K 跨过组合模型原生阈值，先执行真实摘要模型请求，再用原生 checkpoint 构造主请求                   |
| 摘要输入       | 大摘要配对收到原始长输入标记及 Core 追加的模板指令；该场景不丢弃旧 exchange；插件不返回预制 `compaction.result` 来代替摘要请求   |
| Overflow 重建  | fixture provider 返回上下文溢出后，Core 运行原生摘要并重建 context；插件重新过滤候选、创建新绑定，没有自己的压缩 / 重发循环      |
| 辅助入口       | title、Session generate 走固定配对，独立于主路由分类；宿主显式配置的其他摘要模型不被静默覆盖，冲突明确失败                       |
| 工具与并发     | 真实工具执行返回大结果后，下一 Step 排除小窗口档位，tool-call/result ID 保留；并发 Session 不串容量候选或绑定                    |
| 配置发布       | 活动请求保留旧版本；等待 idle 后发布新输出预算、移除最大配对并 reload，目录和绑定一致；非法发布不破坏旧配置                      |

容量 fixture 使用“序列化 UTF-8 bytes / 4 ＋固定开销＋余量”，总输出预留为 1,024 tokens，包含 reasoning。示例目录的 input/context/output 为 995,904 / 996,928 / 1,024。**这些是可重复测试单位，不是真实 provider tokenizer、推理预算映射或端到端 1M 服务验收。**

## 会带入正式实现的发现

适配器最终拒绝请求时，普通 `Error` 会被当前 Core 归为 `UnknownProvider` 并重试。首轮测试实际暴露了这个问题；原型改为抛公开 `AIError({ reason: new InvalidRequestError(...) })`，使本地绑定 / 容量错误立即失败。相关测试同时确认没有物理派发与 `session.retry.scheduled`；真正的 provider overflow 仍单独进入原生压缩。

Core 在 compaction hook 之后继续追加摘要模板，所以摘要配对也在真正发送前检查最终输入。显式宿主 compaction agent 指向其他模型时，原型报告配置冲突，不覆盖它，也不把插件大窗口摘要策略声称为已经生效。

## 复现

在验证 worktree 的 `packages/sdk` 目录、使用仓库指定 Bun `1.4.2`：

```sh
bun verification/self-driving/run.ts
bun verification/compaction/run.ts
bun verification/capacity/run.ts --rerun-each 10 --randomize --seed=237911
bun verification/capacity/audit.ts
bun typecheck
```

根目录检查单独执行 `bun run check`；不从根目录执行测试。runner 隔离 HOME / XDG / 数据库，不传递 provider 凭证，关闭模型抓取。

阶段 0 / 0.1 的本地可行性门槛已满足。原生服务 / 凭证、真实 tokenizer 与长输入质量、决策投影 / deadline、资源选择、审批、已安装客户端与发布仍待后续实现或验收；不将这次 fixture 通过扩大为这些能力已经可用。阶段 1 的独立验收结果见上述报告。
