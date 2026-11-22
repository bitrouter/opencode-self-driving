# 精简实测证据

此目录保存合成任务的计划、结构化结果、任务产物和小型日志，方便在独立仓库 review。它不是完整 Session 日志或账单归档。

| 目录                                                                          | 内容                                   |
| ----------------------------------------------------------------------------- | -------------------------------------- |
| [openrouter-live-20261018](openrouter-live-20261018/)                         | 原始真实连接 / 文本 / MCP 结果         |
| [openrouter-text-diagnostic-20261018](openrouter-text-diagnostic-20261018/)   | 尖括号偏差复现与本地回归               |
| [openrouter-text-remediation-20261018](openrouter-text-remediation-20261018/) | 原指令、明确指令、固定 Mini 的有界对照 |
| [coding-task-live-20261018](coding-task-live-20261018/)                       | 固定 Mini / 插件编码对照及修复后诊断   |

[manifest.json](manifest.json) 逐文件记录原始本地产物位置、原始 SHA-256、当前文件 SHA-256 和是否脱敏。已将本机 checkout 前缀替换为占位符，并清理日志行尾空白；归档的任务 `.ts` 文件加 `.txt` 后缀，保留其原内容，避免被当作插件源码或可执行测试。

不包含凭证值、认证 header、账号余额 / key 查询原文、完整模型目录、宿主 lint 大日志、数据库、tarball、终端帧和依赖。profile 中保留的凭证字段仅为环境变量名 / integration ID。原始 `artifacts/` 不提交，脱敏证据不覆盖原始本地资料。

各轮失败状态保持原样；指令修改、bridge 修复和诊断复测分开记录。读取结论与限制请返回 [验证总览](../validation/README.md)。
