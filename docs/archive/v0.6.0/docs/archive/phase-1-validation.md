# 阶段 1 验证报告

> 历史阶段快照：用例数量、版本和当时结论不代表当前状态。当前结果见 [验证总览](../validation/README.md)。未纳入 evidence 的原始日志和产物仅保留在本地。

状态：**正式包骨架与加载生命周期已本地验收**。当前插件提供未配置状态 RPC，选模与配置仍从阶段 2 开始。本轮只修改 `opencode-self-driving/`，没有修改 Core、Server、Protocol、生成客户端、宿主 workspace 或 lockfile。

## 交付

- [包定义](../../package.json)：`0.1.0-dev.0`、private、server / RPC exports、编译产物与类型声明；未发布。
- [server 入口](../../src/server.ts)：通过公开 `Plugin.define` 和 `ctx.rpc.register` 加载，卸载时释放注册；非空 options 明确拒绝。
- [RPC contract](../../src/rpc.ts)：状态为 `unconfigured`，`enabled: false`、`contextSelection: inherit`、`approval: off`。
- [构建脚本](../../script/build.ts)：保留宿主 peer imports，检查 bundle inputs、实际产物 imports 与绝对开发路径；不把 Effect 或宿主实现打入包。
- [测试](../../test/package.test.ts) 与 [隔离 runner](../../script/test.ts)：使用真实公开 SDK 宿主，通过普通配置加载插件，离线安装本地产物；不使用 SDK 插件注册快捷方式。
- [README](../configuration.md)：构建、普通目录配置加载、状态查询、卸载和复跑方法。

插件当前不注册 `self-driving/auto`，不执行模型请求、上下文选择或自动审批，也不启动后台循环。阶段 0 / 0.1 的固定模型输出、fixture tokenizer 和容量原型没有复制进正式 runtime。

## 基线与结果

- 日期：2026-10-18，macOS，Bun `1.4.2`。
- 验证宿主：OpenCode `2.0.32`，`origin/dev` commit `501b15af26915ba52682e20e220e7e137e89e92f`，独立 worktree `plugin-routing-proof`。
- 正式源码交付在本目录；已从本目录重新构建、打包和运行测试。开发依赖通过忽略的 `node_modules` 链接到上述宿主，链接不进入 tarball。
- 嵌入式 SDK 测试宿主通过公开 `@opencode/plugin/runtime` 的 `ensurePluginRuntime()` 启用 CLI 同样使用的共享模块机制。SDK 不会自动启用该机制；这属于验证宿主初始化，正式插件不调用它。

| 检查                       | 结果                                                                                      | 证据                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 包内 `bun run check`       | 构建、类型检查、声明生成及 5 场景通过                                                     | [构建脚本](../../script/build.ts)、[测试入口](../../script/test.ts)     |
| 随机顺序重复测试           | 阶段 1 当轮：seed `237911`；5 场景 × 10 轮；50 通过、0 失败、190 条断言                   | 后续版本的当前回归见 [阶段 2 报告](phase-2-validation.md)               |
| runtime import boundary    | 3 个 inputs；禁止依赖 0；仅 external `@opencode/plugin`、`@opencode/plugin/rpc`、`effect` | 审计 JSON（本地原始资料：`artifacts/import-boundary.json`）             |
| 本地 tarball               | 8 个文件，仅 JS、声明、manifest 和 README；离线安装后移出源码目录加载通过                 | 产物（本地原始资料：`artifacts/opencode-self-driving-0.1.0-dev.0.tgz`） |
| 宿主根目录 `bun run check` | 34 项 typecheck 成功；lint 0 错误、1,306 条既有 warning                                   | 宿主检查日志（本地原始资料：`artifacts/host-check.log`）                |

`artifacts/`、`dist/` 和开发依赖均被 git 忽略。本报告记录阶段 1 当轮结果，旧测试日志可能在后续迭代中被覆盖；阶段 2 起证据按版本分目录，当前结果应读取阶段 2 报告。阶段 1 的 tarball 与 import audit 仍保留；尚无 hosted CI 结果。

另在依赖已安装的验证 worktree 中，对包内 10 个代码文件显式运行宿主 `oxlint`：0 warning、0 error，见 包 lint 日志（本地原始资料：`artifacts/package-lint.log`）。20 个包与设计文件的 whitespace 检查和本轮修改文件的 Prettier 检查通过。

## 五个实际场景

1. 构建目录通过普通插件配置加载，状态 RPC 校验通过，模型目录不新增 `self-driving` provider。
2. `npm pack` 产物经 `npm install --offline --ignore-scripts --legacy-peer-deps` 安装到独立 consumer，验证文件集、package exports 和普通目录配置加载。peer 由宿主提供，不访问 npm registry；尚未验证 registry 包名安装路径。
3. 在安装产物副本放入会立即抛错的直接 / 间接私有 Effect 包，再通过公开根模块和 `effect/Schema` 导入；仍成功激活，且 Schema 与子路径对象身份一致，证明复用了宿主 runtime。
4. 删除配置后 reload Location，插件退出 inventory、RPC 不可用；恢复配置后再次激活且只注册一份。
5. 不支持的 options 导致插件失败，RPC 不可用；inventory 错误不回显测试 token，不会静默启用策略。

验证读取插件 inventory 前通过公开 `model.list` 等待激活完成，没有 sleep 或轮询。重复测试发现 macOS `/var` 与 `/private/var` 路径表示会随 resolver 缓存不同而变化，现对比较双方使用实际路径；未因此修改产品代码。

## 复跑

使用 Bun `1.4.2`，从本目录执行；`dev:link` 可显式指定已安装依赖的兼容 OpenCode checkout：

```sh
bun run dev:link /path/to/qualified/opencode
bun run check
bun run test -- --rerun-each 10 --randomize --seed=237911
```

宿主检查从验证 worktree 根目录运行 `bun run check`。本包不在宿主 workspace glob 内，宿主检查不能替代包内检查。

后续仍待阶段 2 起完成原生决策 / 生成绑定、五档配置、容量策略、投影与 deadline、资源选择和审批。没有调用付费模型，没有读取真实 provider 凭证，也没有连接、替换或修改已安装 OpenCode 的服务 / 配置；本次不声明真实 provider、已安装客户端、Linux / Windows 或发布兼容性。
