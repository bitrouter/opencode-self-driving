# 文本失败的修复验证

日期：2026-10-18（America/New_York）。插件 `0.6.0-dev.0`，原有 OpenCode V2 `2.0.32` 隔离宿主、公开 SDK / 插件 API、原生 OpenRouter Evaluation / 生成绑定。

**新版连通性样例采用明确的字符级指令；通用路由质量仍未取得资格。** 两种干预在本轮小样本中均通过，尚不能给出成功率保证或据此更换默认模型池。

## 冻结的对照设计

在调用前记录三组、每组两次的计划，按 baseline → explicit-prompt → fixed-mini 顺序执行两轮。每次最多 3 次模型请求、30 秒、每次生成最多 128 tokens，整个对照最多 18 次模型请求。单次失败不重试；后续运行是预先列出的独立实验。

- baseline：沿用原 profile、原始指令及精确期望，实际生成命中 Nano。
- explicit-prompt：只改变 prompt 与实验标识，保持原模型池。
- fixed-mini：保留原始指令，将五个档位的物理模型都配置为原模型池已有的 `openai/gpt-4.1-mini`，以固定生成模型。辅助模型配置保留。

三组均保留 `expectedText = QUALIFICATION_TEXT`、trim 后精确比较、无关可选资源及其标签、资源选择模式、审批模式与阈值。没有调 confidence 阈值、输出清洗、隐式 fallback 或生成重试。fixed-mini 改变了路由候选描述和组合容量元数据，因此是配置级对照，不是脱离宿主上下文的纯模型基准。

原始指令：

```text
Reply with exactly QUALIFICATION_TEXT and nothing else.
```

新版指令：

```text
Output exactly these 18 ASCII characters, with no surrounding characters:
QUALIFICATION_TEXT
The first character must be Q and the last must be T. Do not add angle brackets, quotation marks, Markdown, explanations, or extra text.
```

## 实测结果

| 配置                   | 精确匹配 | 两次实际长度 | 实际生成模型          |
| ---------------------- | -------- | ------------ | --------------------- |
| 原指令、原模型池       | 0/2      | 96、95       | `openai/gpt-4.1-nano` |
| 明确指令、原模型池     | 2/2      | 18、18       | `openai/gpt-4.1-nano` |
| 原指令、固定 Mini 配置 | 2/2      | 18、18       | `openai/gpt-4.1-mini` |

6 次预检均 ready，预检 provider 请求为零。实际共 18 次模型 HTTP 请求：12 次 Evaluation、6 次生成，全部 HTTP 200；6 个 Session 均 succeeded、各 1 Step，没有触及 relay 额度。原指令的两次文本失败仍记为 incomplete。

所有路由均选择 low，confidence 均为 0.99；这进一步说明该值不能代替实际输出验收。两次 baseline 输出首字符分别为 `S` / `P`，长度为 96 / 95；正文未保存，不能补写其含义，也不能把它们描述为此前复现的 `<QUALIFICATION_TEXT>`。其余四次输出的长度与完整 SHA-256 都与原期望一致。

两次成功不能证明模型稳定遵从格式；同一合成 marker 的重复属于 tuning 探索，不是独立 holdout、代表性编码质量或概率校准。本轮没有新增账单查询，不报告准确增量费用。

## 已应用的最小改动

[qualification.json](../../examples/qualification.json) 将文本样例改为明确字符级指令，并使用新 ID `text-connectivity-literal-v2`。期望文本、验证器、原始计划和失败报告保持原样。该改动使连通性探针更明确，未建立对任意用户输入的格式保证。

对于实际用户任务，若要求更稳定的严格输出，应以代表性任务验证现有模型配对，再显式调整 profile。当前结果支持将 Mini 作为后续候选，但不足以发布通用模型质量结论。通用路由器没有每个任务的确定答案，不能用这个 marker 的校验规则修复任意模型输出。

MVP 继续使用既有文本绑定和宿主执行机制。当前 `src/bridge.ts` 明确拒绝非 text 的 `responseFormat`；结构化输出需要另行设计、实现和验收，不能作为已经支持的一行配置修复。

新版模板的 cases 已用真实 `decodePlan` 配合有效 profile 验证，字符数与原期望保持一致；六份实验计划的差异已逐项核对。格式检查通过；在原有依赖齐全的兼容性 checkout 同步源码后，根目录 `bun run check` 通过，34 个 typecheck 任务均命中缓存，lint 仍为既有 1,306 条警告、0 错误。此轮没有 runtime 或验证器变更，未新增单元测试。

## 证据

精简计划与报告位于 [本轮证据](../evidence/openrouter-text-remediation-20261018)，不包含凭证或通用生成正文：

- [预先冻结的设计](../evidence/openrouter-text-remediation-20261018/design.json) / [机器汇总](../evidence/openrouter-text-remediation-20261018/summary.json)
- 原指令：[第一次](../evidence/openrouter-text-remediation-20261018/baseline-1-live.json) / [第二次](../evidence/openrouter-text-remediation-20261018/baseline-2-live.json)
- 明确指令：[第一次](../evidence/openrouter-text-remediation-20261018/explicit-prompt-1-live.json) / [第二次](../evidence/openrouter-text-remediation-20261018/explicit-prompt-2-live.json)
- 固定 Mini：[第一次](../evidence/openrouter-text-remediation-20261018/fixed-mini-1-live.json) / [第二次](../evidence/openrouter-text-remediation-20261018/fixed-mini-2-live.json)

旧证据见 [失败分析](text-failure-analysis.md) 与 [原始真实接入报告](openrouter-live.md)。本轮不覆盖或改判旧结果。
