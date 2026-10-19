# 验证总览

基线：插件 `0.6.0-dev.0`，Bun 1.4.2，OpenCode V2 2.0.32 / `501b15af26915ba52682e20e220e7e137e89e92f`，macOS。下表区分实现验证、真实接入和任务质量。

| 验证                                               | 结果与范围                                                            | 证据                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 包内集成检查                                       | 128 项测试通过；SDK、离线 tarball、生命周期、策略、TUI 组件；loopback | [编码对照中的检查记录](coding-task-live.md#bridge-修复与验证)         |
| 多段文本结果回归                                   | 工具续步 / 跨档位与媒体拒绝，各重复 10 轮通过                         | [编码对照](coding-task-live.md)                                       |
| 原生 TUI 终端联调                                  | 本地隔离 V2 CLI/TUI、普通安装产物与 loopback 服务                     | [阶段 6 快照](../archive/phase-6-validation.md)                       |
| OpenRouter 真实连接                                | 部分通过；Jev、原生 key、Nano / Mini / GPT-4o Mini 有调用证据         | [连接实测](openrouter-live.md)、[编码对照](coding-task-live.md)       |
| 精确文本                                           | 原指令失败；明确字符级指令在两次探索调用中通过                        | [失败分析](text-failure-analysis.md)、[指令对照](text-remediation.md) |
| 真实文件修改任务                                   | 当前插件配置弱于固定 Mini；双方均未完整通过验收                       | [编码任务对照](coding-task-live.md)                                   |
| 自动审批实际放行、概率校准、长窗口、代表性编码质量 | 未取得资格                                                            | [验收边界](../qualification.md)                                       |
| npm 发布、hosted CI、生产使用                      | 尚无通过声明                                                          | [开发说明](../development.md)                                         |

HTTP 200 不代表任务完成；Session succeeded 也不代表代码正确。未通过任务验收的短耗时不计为效率提升，生成 tokens / catalogCost 不能替代含决策服务的完整物理账单。

可在仓库中查看的精简计划、报告与产物见 [evidence](../evidence/README.md)。没有纳入该目录的原始 artifacts、终端帧、数据库和早期原型仅保留本地；归档中的文本路径不是已发布文件链接。
