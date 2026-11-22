# 真实编码任务对照

日期：2026-10-18（America/New_York）。OpenCode V2 `2.0.32` / `501b15af26915ba52682e20e220e7e137e89e92f`，Bun `1.4.2`，macOS，插件 `0.6.0-dev.0`。

**当前 self-driving 配置未优于固定 GPT-4.1 Mini；没有一组通过完整任务验收。** 这是隔离小项目中的实际读文件、改代码、运行测试任务，不是生产仓库缺陷修复或统计性能基准。首次对照暴露一个 bridge 缺口，修复后又进行一次独立记录的插件组诊断复测。

## 任务与控制

修复 CSV→JSON CLI 的 `src/csv.ts` 和 `src/import.ts`：处理引号、逗号、字段内换行、CRLF、转义引号、BOM、空记录、错误引号、重复 / 空表头、行宽与特殊属性名。[任务要求](../../script/coding-benchmark/fixture/README.md) 和 [独立验收](../../script/coding-benchmark/acceptance.test.ts.txt) 在付费调用前冻结。初始代码公开测试 1/5、独立验收 1/16。

两组使用相同初始文件、用户 prompt、原生 `read / edit / write / shell` 工具与验收，分别运行在新的临时项目、Session、DB 和 HOME / XDG 环境。只允许修改两个实现文件；其余文件的完整哈希确认未变。

- 对照组不加载 self-driving，使用公开 `sessions.switchModel` 固定原生 `openrouter/openai/gpt-4.1-mini`。
- 实验组加载正式 self-driving bundle，使用既有 Jev Choice 和模型池：low = GPT-4.1 Nano、medium = GPT-4o Mini、high / xhigh / max = GPT-4.1 Mini。上下文 `inherit`，自动审批 `off`；本次不测这两项策略效果。
- 工具循环、Step、权限和结束均由真实 OpenCode Core 执行，入口为 headless SDK；没有自写 agent loop，没有连接全局旧版 CLI / live service。

Core 保留原生模型相关的 system prompt 构造。本次比较插件整体路径与固定模型路径，不能隔离路由算法本身的因果效果。

## 结果

| 运行                        | Session   | 公开测试 | 独立验收 | 耗时     | 模型请求        |
| --------------------------- | --------- | -------- | -------- | -------- | --------------- |
| 固定 Mini                   | succeeded | 5/5      | 14/16    | 31.32 秒 | 11 生成         |
| self-driving 首轮           | failed    | 1/5      | 7/16     | 8.64 秒  | 6 决策 + 5 生成 |
| self-driving 修复后诊断复测 | succeeded | 加载失败 | 加载失败 | 15.15 秒 | 7 决策 + 7 生成 |

复测的 `csv.ts` 有语法错误，测试在导入阶段失败，**5 项公开测试 / 16 项独立验收均未执行**，不伪记为所有断言已运行。模型没有调用 shell 执行要求的 `bun test`。Session succeeded 仅代表原生执行结束。

固定 Mini 遗漏了拒绝未闭合引号，以及使 `__proto__` 成为普通自有数据属性。实验组首轮前五次生成都是 Nano；第六次路由选到 high / Mini，但没有发出第六次生成请求。修复后复测实际使用 Nano 2 次、GPT-4o Mini 5 次，未命中高档 Mini。

较短耗时对应未完成的任务，不能作为完成同等任务更快的证据。复测是同任务诊断，路由与生成具有随机性，且 Step 上限为守住剩余预算从 18 收紧为 16；不能把质量变化归因于 bridge 修复，也不能将其作为新的独立 holdout。

## 用量与预算

首次每组最多 18 Steps、6 分钟、每次生成 2,048 tokens；请求上限对照组 18、实验组 36，合计 54。首次实际 22 次，复测最多 16 Steps / 32 次请求，实际 14 次。**累计 36 次真实模型请求，全部 HTTP 200**：13 次决策、23 次生成，无预算超限，剩余额度没有继续使用。

| 运行              | 生成输入（含 cache） | 其中 cache read | 生成输出 | 决策输入 | 决策输出 |
| ----------------- | -------------------: | --------------: | -------: | -------: | -------: |
| 固定 Mini         |               55,442 |          47,488 |    3,170 |        0 |        0 |
| self-driving 首轮 |               11,152 |           8,064 |      679 |   39,546 |      318 |
| 修复后诊断复测    |               17,120 |          11,904 |    1,057 |   46,922 |      371 |

生成输入按公开 Session tokens 的 uncached + cache read + cache write 计；决策来自全部 Route 原生 usage，包含首轮最后一次未生成的决策。不同模型与 cache 计费不同，tokens 不能直接当美元比较。未取得物理请求账单；Session catalogCost 不含决策服务，**不能声称总体省钱**。

## Bridge 修复与验证

原生 shell 对非零退出返回多个 text content：测试输出与退出码 notice。Core 将其映射为 AI SDK `output.type = content`，旧 bridge 对所有 content 一律拒绝。首轮停止恰在失败的 `bun test` 后、下一次决策完成后、物理生成前。

本地重建这种输入，旧实现抛出 `Multimodal and denied tool results are unsupported by this binding`；真实 SDK + 安装产物回归也先失败。首轮临时 DB 已清理，未保存最终异常正文，不能声称事后直接读取了该 Session 异常；上述归因由本地复现和源码链路支持。

[src/bridge.ts](../../src/bridge.ts) 已支持完全由 text 构成的多段结果，保留内容与顺序；实际媒体与 denied 结果继续拒绝。没有新增 hook、服务、凭证方式、隐式生成重试或 fallback，也未调整 confidence 策略。

完整检查 **128 项 / 433 条断言通过**。工具续步 / 跨档位回归与媒体拒绝回归各重复 10 次：**20 项 / 60 条断言通过**。真实复测未调用 shell，因此“失败 shell 后恢复”目前有本地 SDK / 安装产物证据，没有新增真实 provider 正向证据。

插件 lint 为 0 警告 / 0 错误。在依赖完整的兼容性 checkout 同步源码后，根目录 `bun run check` 通过，34 个 typecheck 均命中缓存。91 份新增实验资料 / 相关源码的凭证值扫描为零匹配；复测 source / bundle 哈希与冻结设计一致。

当前模型池与路由组合尚未通过真实编码任务质量验收。下一步应以代表性任务完整通过率筛选配对，再验证路由；单个任务不足以给档位下普遍结论。Choice confidence 不是编码成功概率，不根据本样本临时加阈值。本轮没有增加自动纠错或续跑机制，Core 继续拥有执行生命周期。

## 证据

- [总汇总](../evidence/coding-task-live-20261018/summary.json) / [初始设计](../evidence/coding-task-live-20261018/design.json)
- [首次完整对照](../evidence/coding-task-live-20261018/comparison-1) / [验收结果](../evidence/coding-task-live-20261018/comparison-1/acceptance-results.json)
- [固定 Mini 产物](../evidence/coding-task-live-20261018/comparison-1/baseline-workspace/src) / [插件组首次产物](../evidence/coding-task-live-20261018/comparison-1/self-driving-workspace/src)
- [修复后复测](../evidence/coding-task-live-20261018/post-fix) / [加载错误](../evidence/coding-task-live-20261018/post-fix/acceptance-results.json)
- [旧实现本地异常复现](../evidence/coding-task-live-20261018/comparison-1/offline-stop-reproduction.json) / [回归修复前](../evidence/coding-task-live-20261018/regression-red.log) / [完整检查](../evidence/coding-task-live-20261018/check.log) / [重复回归](../evidence/coding-task-live-20261018/regression.log)

最早一次启动漏显式 Session model，被本地白名单拦截，provider 请求为零；顶层 `baseline-live.json` 保留该记录，不计为对照模型失败。修正执行器后才开始付费比较。凭证只经公开 credential API 导入临时宿主；控制进程已退出，临时 DB / HOME 已清理，仅复制合成项目和统计资料供 review。
