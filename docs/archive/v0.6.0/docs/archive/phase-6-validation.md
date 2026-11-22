# 阶段 6：TUI 与交付验收

> 历史阶段快照：用例数量、版本和当时结论不代表当前状态。当前结果见 [验证总览](../validation/README.md)。未纳入 evidence 的原始日志和产物仅保留在本地。

日期：2026-10-18（America/New_York）。包版本 `0.6.0-dev.0`，private，未发布。所有宿主行为仍通过现有公开 API；未修改 Core、Server、Protocol 或生成客户端。

## 已实现

- `tui` 入口、声明和离线可安装 tarball；Solid / OpenTUI 为外置可选 peer，headless 保持独立。
- `/self-driving [on | off | config | status | policies]` 与命令面板入口。
- 原生 dialog 导入完整 profile JSON、审阅、编辑、保存草稿、确认发布；五档 / 辅助模型和 variant 从公开原生目录选择。没有新增服务、登录或凭证值存储。
- 当前 Session 的资源与审批模式独立设置；启用 / 停用通过真实 server RPC，恢复原模型及 variant。
- 状态面板与底栏：组合窗口、候选 / 排除原因、实际请求目标、决策身份 / confidence、资源、审批、用量与失败；宽屏分栏、窄屏全屏换行、Escape / 点击关闭。窗口变化使用公开 OpenTUI hook；颜色使用宿主语义 token。
- 仅按公开配置 / 生命周期事件刷新 UI，无持久化观察器或轮询 agent loop。命令开始时固定目标 Session / Location，避免对话框期间切换页面改变操作对象。
- [安装说明](../installation.md)、README 与 spec 同步更新；发布、stateful observer、插件恢复仍未纳入。

## 验证环境

依赖与开发宿主使用 OpenCode V2 `2.0.32`，commit `501b15af26915ba52682e20e220e7e137e89e92f`，Bun `1.4.2`，macOS。主工作目录 commit `60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006` 缺少完整开发依赖，因此宿主全量检查在已安装依赖的 qualification worktree 执行；独立插件包另行执行自身完整 check。

当前全局安装客户端 `opencode 1.18.3` 使用旧 API，不兼容本包，未替换或连接其后台服务。本次 CLI/TUI 证据来自隔离的 V2 开发客户端。

## 检查与回归

- 包内 `bun run check`：125 个测试通过，421 条断言，0 失败。含 9 个新增 TUI 场景：真实 RPC 配置 / 命令、取消发布、凭证字段拒绝、原生模型 / variant、Session 独立策略、生产组件 44 / 100 列布局及底栏。
- 8 个 TUI 命令 / 状态场景随机顺序重复 10 轮，与 3 个配置 / 发布回归合计 110 次通过、420 条断言；生产底栏另重复 10 轮，10 次通过。共 9 个新增 TUI 场景各通过 10 轮。
- 宿主根目录 `bun run check`：34 项 typecheck 成功（缓存），全量 lint 无错误；宿主现有 1,306 条 warnings 与插件检查分开报告。
- 插件独立 oxlint：0 warnings / 0 errors。
- 构建审计：104 个 runtime 输入，禁止的 Core / Server / SDK 导入为空；Effect、Solid、OpenTUI 保持 external，无绝对开发路径。离线安装测试验证 server / rpc / tui 入口解析和分发文件集合。

## 统一原生 CLI/TUI 联调

运行：

```sh
bun run check
bun run smoke:tui /path/to/qualified/opencode
```

脚本从最终构建产物生成的 tarball 离线安装，在独立 HOME / XDG / 数据库与 tmux socket 中启动原生 V2 服务，再通过 `dev:live` 连接。使用正常插件目录配置，不通过 SDK 直接注入 TUI。流程全部通过：

1. server 插件加载，组合模型尚未配置；TUI 正常发现已安装包的 `tui` 入口。
2. 在 TUI 粘贴完整 profile，选择发布并经过原生确认；server 保存已发布 revision。
3. TUI 启用当前 Session，再分别选择 context `select`、approval `auto`。
4. 从原生输入框提交指令；资源决策省略显式 opt-in 的 `smoke-optional`，Choice 路由到 `medium / low effort`。
5. 原生 ask 依据精确 MCP 参数获得插件的允许结论，`fixture_echo` 实际执行一次；Core 写入工具结果并执行下一 Step，再次路由，显示 `SELF_DRIVING_LIVE_OK`。
6. 查看 110 列状态分栏、60 列全屏状态和动态短底栏 `SD:medium`；Escape 关闭后可以继续输入命令。
7. TUI 停用，公开 Session API 确认恢复 `fixture-openai / low / high variant`；资源 / 审批恢复 `inherit / off`。
8. 公开 Location reload 后，配置与发布 revision 保留。

成功报告：`artifacts/0.6.0-dev.0/tui-1792373677959/report.json`。共 **7 次 loopback HTTP 请求**（5 次 Evaluation、2 次物理生成）、**1 次 MCP 工具执行**、**0 次真实 provider 请求**。同目录保留确认界面、窄宽状态 / 底栏文本帧、公开状态和 Session log。只记录 fixture 结果，不将概率 0 / 1、测试 token usage 或响应延迟作为模型质量、校准或成本证据。

联调发现并修复三个实际问题：TUI 压缩 import 格式影响宿主共享模块识别、窄屏状态面板缺少关闭入口、读取 renderer 宽度不能自动刷新短底栏。最终成功运行包含这些修复。失败调试记录与最终通过报告分开保留，没有隐藏重试或生成 fallback。

## 尚未验收

以上阶段 6 联调当时未执行真实 provider。后续已使用用户提供的 key 完成 [OpenRouter 真实接入 smoke](../validation/openrouter-live.md)，结果部分通过。概率校准、代表性编码质量、tokenizer / 长窗口、完整自动放行与 OAuth / external 支持资格仍未获得。

没有已发布 npm 版本、hosted CI、全局已安装客户端、Windows / Linux TUI 或插件恢复的验收声明。当前配置 UI 对服务 / 预算 / 阈值使用 JSON 编辑；没有另建多字段表单框架。
