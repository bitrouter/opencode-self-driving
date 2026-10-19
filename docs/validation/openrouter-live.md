# OpenRouter 真实接入验收

日期：2026-10-18（America/New_York）。插件 `0.6.0-dev.0`，OpenCode V2 `2.0.32` / `501b15af26915ba52682e20e220e7e137e89e92f`，Bun `1.4.2`，macOS。结论：**部分通过，质量与概率校准仍为 not-qualified**。

本次使用用户提供的真实 OpenRouter test key，通过现有 `qualify` 工具、公开 SDK / 插件 API、原生 integration key connection、原生 OpenRouter Evaluation 和生成绑定执行。未新增 adapter、登录方式或宿主 hook；runtime 实现未改动。

## 范围与预算

认证检查 `GET /api/v1/key` 返回 200；隔离宿主 preflight 为 ready，模型转发请求为零。随后冻结模型、阈值、样本和预算：

| 项目     | 配置 / 结果                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 决策入口 | 原生 OpenRouter `experimental.evaluation`，实际兼容路径 `/api/v1/systemone`                                                               |
| 决策模型 | `typesafe/jev-1.14`；严格接受 `typesafe/jev-1.14-20261014` 返回身份                                                                       |
| 五档配对 | low：`openai/gpt-4.1-nano`；medium：`openai/gpt-4o-mini`；high / xhigh / max：`openai/gpt-4.1-mini`                                       |
| 预算     | 累计最多 10 次模型 HTTP 请求，每次生成最多 128 tokens，执行时长上限 90 秒，累计输入 300,000 bytes、响应 262,144 bytes，每样本最多 3 Steps |
| 资源阈值 | `tauOmit = 0.10`                                                                                                                          |
| 审批阈值 | `tauAllow = 0.05`；只允许本地 `qualification` MCP echo 探针                                                                               |
| 凭证     | 本次环境变量引用，经公开 `credential.create` 导入隔离宿主的原生 key connection                                                            |

三个生成模型均通过原生目录 / 配对 / 容量 preflight；本次实际生成只命中 `gpt-4.1-nano`。其余档位、辅助 title / compaction / generate 和长窗口只完成配置检查，没有真实生成资格声明。阶段 6 的原生 TUI + tarball 联调证据继续见 [阶段 6 报告](../archive/phase-6-validation.md)；本次真实 provider 使用 headless SDK 路径。

OpenRouter 官方说明了 [System One 兼容入口](https://openrouter.ai/blog/insights/what-is-jev/) 与 [当前 key 查询接口](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)。本次直接实测了已有原生绑定，无须加入 alpha Decisions transport。

## 样本结果

| 样本 / 路径    | 实测                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 可选资源判断   | Jev 返回 `p(needed)=0.05 < 0.10`；显式 opt-in 的无关资源实际省略                                                                     |
| 主路由         | 3 次 Choice 均选择 low，分布与 confidence 有效；请求 / 返回模型身份匹配                                                              |
| 物理生成       | 3 次 `gpt-4.1-nano` 流式生成均 HTTP 200，原生 Session 成功结束并记录 token usage                                                     |
| 文本样本       | 1 Step，Session succeeded；`QUALIFICATION_TEXT` 精确文本断言失败，保留失败结果                                                       |
| MCP 审批       | auto 模式返回 `p(needs_human)=0.10 >= 0.05`，插件维持原生 ask，结果为 manual-required                                                |
| MCP 执行与续步 | 测试 consumer 对预先授权的精确 echo 参数回复 once；工具实际执行 / 匹配各 1 次，Core 完成 2 Steps，最终 `QUALIFICATION_DONE` 精确匹配 |

原始计划在文本断言失败后停止，未执行第二个样本。随后把**原计划中未运行的 MCP 样本**单独执行一次，模型、阈值与标签不变；新计划将剩余请求上限设为 7，输入 / 响应额度扣除已使用值，时长上限收紧为 60 秒。原失败报告保留，未重跑失败样本、调阈值、换模型或隐式 fallback。

MCP 样本的成功包含 **1 次测试 consumer 的原生 ask 回复**。真实 ask→allow 尚未获得成功样本；不能将这次人工回复计为插件自动批准。保守阈值分支按约定工作，但单个正例不足以校准阈值。

后续已进行一次有界诊断，复现输出为 `<QUALIFICATION_TEXT>`，比期望多一对尖括号；长度、首个差异码点和完整 SHA-256 一致确认该格式偏差。原始运行未保存正文，仍保留原失败状态；详细证据与归因限制见 [文本失败分析](text-failure-analysis.md)。MCP 最终文本精确匹配提供了另一条真实生成 / 历史 / 采集路径的正向证据。

另一次独立修复对照新增 18 次模型请求：原指令 + Nano 0/2 通过，明确字符级指令 + Nano 2/2 通过，原指令 + Mini 2/2 通过。模板已改用具有新 ID 的明确指令；原失败仍保留。Mini 因此增加了两次真实文本生成证据，但不构成其他档位或编码质量资格，详见 [修复验证](text-remediation.md)。下文总量仍只统计原始 8 次请求。

## 总量与证据

- **8 次真实模型 HTTP 请求，全部 200**：5 次 Evaluation、3 次生成。另有 2 次 key 查询和 1 次公开模型目录查询；这些不属于模型推理请求。
- 累计请求体 37,745 bytes、响应体 7,808 bytes，未触及额度，未发生工具外部副作用。
- Key API 报告的用量增量为 **$0.000236892**，属于 key 用量读数，不是物理供应商发票或组合模型估价。
- 凭证没有进入仓库、计划或报告；本次控制进程已退出，临时宿主及数据库已删除。报告只保留模型、状态、用量、诊断和合成样本判定。

原始 artifacts 保留本地；以下链接指向入库的精简证据：

- [汇总](../evidence/openrouter-live-20261018/summary.json)
- [预检](../evidence/openrouter-live-20261018/preflight.json)
- [首轮原始计划](../evidence/openrouter-live-20261018/plan.json) / [原始结果](../evidence/openrouter-live-20261018/live.json)
- [MCP 独立后续计划](../evidence/openrouter-live-20261018/mcp-followup-plan.json) / [结果](../evidence/openrouter-live-20261018/mcp-live.json)
- 认证 / key 用量查询原文仅保留本地，账号额度不入库；相关推理统计见上方汇总。

本次验证了具体服务、模型与 key connection 的真实接入。完整自动放行、其他文本质量问题、概率校准、代表性编码质量、真实 tokenizer / 大窗口、其他 provider / 凭证方式及已安装旧客户端继续待验收。Stateful observer 与插件恢复继续 defer。
