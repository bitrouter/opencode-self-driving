# 文本精确匹配失败分析

日期：2026-10-18（America/New_York），插件 `0.6.0-dev.0`。**同配置复现已确认失败形式：返回文本多了一对尖括号。严格校验按约定判失败。**

```text
期望：QUALIFICATION_TEXT
复现：<QUALIFICATION_TEXT>
```

原始运行没有保留正文或正文哈希，无法事后逐字证明其输出。以下结论区分新复现的直接证据与对原始失败的归因。

## 直接证据

在原 profile、样本指令、模型池和阈值下，新建隔离宿主执行一次诊断；只收紧运行预算为最多 3 次模型请求、30 秒、每次生成最多 128 tokens。实际 2 次 Jev 决策、1 次 GPT-4.1 Nano 生成，全部 HTTP 200，Session succeeded，文本断言仍为 false。

| 项目               | 诊断结果                                                           |
| ------------------ | ------------------------------------------------------------------ |
| 实际物理模型       | `openai/gpt-4.1-nano`，low 档                                      |
| assistant / 文本块 | assistant 存在，1 个文本块                                         |
| 期望 / 实际长度    | 18 / 20，均为 ASCII 字符                                           |
| 首个差异           | UTF-16 offset 0，期望 `Q`（81），实际 `<`（60）                    |
| 实际文本 SHA-256   | `3961b67122aa600ea8b2380e2ac2ea9b16f39041085384eaf0d5ffd1502ec4c4` |
| 候选校验           | 上述哈希与 `<QUALIFICATION_TEXT>` 完全一致                         |

因此，尖括号包装由完整哈希匹配确认，并非仅凭首字符猜测。诊断报告仅记录长度、SHA-256 与首个差异字符的码点；没有保存通用生成正文、header 或凭证。这里展示的是已知合成 marker 的差异。

复现与原始运行均选中 Nano、输出 6 tokens、生成请求体 2,054 bytes、响应体 2,408 bytes，且同样省略无关资源。它们支持原始失败也源自相同包装行为；由于原始正文不可恢复，这仍是有证据支持的归因，不能声称两次返回字节已被直接比对。

## 采集与流式链路

检查的路径为 OpenRouter Chat SSE → 原生 AI 文本事件 → 插件 bridge → Core 持久化文本 → `Session.context` → 精确比较。

- 原生 Chat parser 将 `delta.content` 原样传给 `Lifecycle.textDelta`。
- `src/bridge.ts` 将 `event.text` 原样映射为 AI SDK 的 `delta`。
- Core 的文本 fragment 将字符串追加、拼接，再写入 `Text.Ended`；此处不添加尖括号。
- `script/qualification/run.ts` 等待 Session 结束，取最后一个 assistant 的文本块，拼接并 `trim()` 后比较。`trim()` 只去除首尾空白，不移除尖括号。

另外通过真实 SDK / 安装产物回放空 role 首包、多段文本、跨 JSON 边界的 37-byte 网络块、独立 usage 尾包和 `[DONE]`。精确文本完整保留；另用带额外引号的负例确认失败与差异诊断均正确。两个场景各重复 10 轮，20 次通过 / 140 条断言。

这些证据支持将复现失败归为模型输出格式不遵从。没有发现字符串转换或采集时序造成此包装的证据。6-token 生成也未接近 128-token 上限；本次没有容量溢出、HTTP 失败或上下文裁剪错误。

## 对实现与后续验收的含义

原样本要求 exactly / nothing else；额外字符违反该输出契约。校验器应继续保留失败，不能通过剥离 `< >` 改判原结果。

路由的高 confidence 表示 Choice 分布集中，不保证所选编码模型会满足本次精确文本要求。这次 Nano 输出不遵从，可作为低档模型服从硬格式约束的负例；单个样本不能用于校准路由 confidence 或断言整个档位不可用。

后续可使用独立样本比较更明确的字符级输出指令，或比较固定物理模型的格式服从率，再决定是否调整档位映射。原始失败与本次复现应保留在记录中，不并入调参后通过结果。

本次仅改进开发验收工具的 `textComparison` 诊断，未修改插件 runtime、路由、模型配对、阈值或精确匹配标准。包内完整检查 126 场景 / 427 条断言通过；新增诊断与分块流式回归各重复 10 轮通过，插件 lint 无警告 / 错误。

## 证据位置

- [原始失败报告](../evidence/openrouter-live-20261018/live.json)
- [诊断计划](../evidence/openrouter-text-diagnostic-20261018/plan.json) / [复现报告](../evidence/openrouter-text-diagnostic-20261018/live.json)
- [完整包检查](../evidence/openrouter-text-diagnostic-20261018/check.log) / [10 轮本地回放](../evidence/openrouter-text-diagnostic-20261018/replay.log)

本次诊断增加 3 次真实模型请求；旧的 8 次实测报告与结果保持不变。Key API 的后续读数另行留存，未将不同时点用量读数之差作为本次诊断的准确费用。

后续又进行了 18 次请求的独立有界对照：原指令 + Nano 0/2 通过，明确字符级指令 + Nano 2/2 通过，原指令 + Mini 2/2 通过。新一轮原指令的失败文本长度为 96 / 95，并非此前确认的 20 字符尖括号包装；报告未保存这些正文，不能声称它们具有相同包装形式。模板已采用有独立 ID 的新指令样例；原始失败和比较规则保留。详见 [修复验证与适用范围](text-remediation.md)。
