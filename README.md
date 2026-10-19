# opencode-self-driving

OpenCode V2 插件：为每个模型请求选择模型 / reasoning 档位，并提供显式启用的上下文选择与工具审批策略。严格使用现有公开插件 API；Session、工具循环、压缩、重试和结束判断继续由 OpenCode 管理。

**状态：实验性，`0.6.0-dev.0`，尚未发布 npm 包。** 本地集成检查已通过，真实 OpenRouter 接入部分通过；当前配置在一次编码任务对照中弱于固定 GPT-4.1 Mini，双方均未通过完整验收。尚不能声明编码质量、概率校准或成本收益合格。

## 开始使用

已验证基线：macOS、Bun **1.4.2**、OpenCode V2 **2.0.32**，源码 commit `501b15af26915ba52682e20e220e7e137e89e92f`。不声明兼容其他 OpenCode 版本。

在本目录链接兼容 OpenCode checkout 的已安装依赖，然后构建与检查：

```sh
bun run dev:link /path/to/dependency-installed/opencode
bun run check
```

将构建后的完整目录加入兼容宿主的配置：

```json
{
  "plugins": [{ "package": "/absolute/path/opencode-self-driving" }]
}
```

首次加载保持 `unconfigured`。在 Session 中执行 `/self-driving config`，导入填好的 [profile](examples/profile.json)，审阅并发布，再执行 `/self-driving on`。服务、凭证引用、五档模型、辅助模型和预算都必须明确填写；模板的占位符与零值不能直接运行。

| 命令                       | 用途                                      |
| -------------------------- | ----------------------------------------- |
| `/self-driving config`     | 配置、原生模型 / variant 选择、审阅与发布 |
| `/self-driving on` / `off` | 启用当前 Session，或恢复原模型            |
| `/self-driving policies`   | 独立设置上下文与审批模式                  |
| `/self-driving status`     | 查看路由、用量和状态                      |

上下文选择默认 `inherit`，自动审批默认 `off`。原生 AGENTS.md、skills、MCP、CodeMode 和未知资源保留；stateful observer 与插件恢复后置。

## 文档与验证

- [文档总览](docs/README.md)：使用、设计、研究和历史归档。
- [安装与兼容范围](docs/installation.md)、[完整配置 / RPC / 运行机制](docs/configuration.md)。
- [当前验证状态](docs/validation/README.md)、[真实编码任务对照](docs/validation/coding-task-live.md)。
- [设计规格](docs/spec.md)、[开发与复跑](docs/development.md)。

独立仓库仅包含插件及其文档、测试和开发工具。`dist/`、依赖、原始 `artifacts/`、本地数据库和凭证不提交；精简并脱敏的合成实测资料位于 [docs/evidence](docs/evidence/README.md)。
