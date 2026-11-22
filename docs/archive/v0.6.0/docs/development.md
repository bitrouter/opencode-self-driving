# 开发与复跑

使用 Bun **1.4.2**。开发与测试依赖当前来自兼容 OpenCode V2 源码 checkout，已验证 commit 为 `501b15af26915ba52682e20e220e7e137e89e92f`。此仓库不包含宿主源码，也不保证仅安装同名 npm 包就能重现该开发环境。

从仓库根目录执行：

```sh
bun run dev:link /path/to/dependency-installed/opencode
bun run check
```

`dev:link` 仅在本地 `node_modules` 创建开发依赖链接；不会修改 OpenCode manifest / lockfile。`check` 执行类型检查、bundle / 类型声明生成、runtime 导入边界审计，以及真实 SDK / 离线 tarball / TUI 组件测试。测试只调用 loopback 服务和 fixture key，不使用真实凭证。

```sh
bun run test -- --rerun-each 10 --randomize --seed=237911
npm pack --ignore-scripts
bun run smoke:tui /path/to/qualified/opencode
```

`smoke:tui` 使用独立 HOME / XDG、数据库、tmux socket 和兼容 checkout 的 `dev:live`；不替换现有全局客户端或服务。结果写入忽略的 `artifacts/<version>/`。不要手工编辑 `dist/`。

真实模型调用另见 [有界验收](qualification.md) 与 [编码实验说明](../script/coding-benchmark/README.md)。必须先冻结计划、模型、预算和判据，再显式使用 `--execute`；不自动重跑付费失败。凭证仅通过临时环境变量 / 原生 integration 引用提供，禁止写入配置、文档、日志或仓库。

## 仓库边界

- runtime 只使用现有公开 API，不依赖 Core / Server / SDK 实现路径；SDK 只用于开发验证。
- 宿主继续拥有 Session、工具循环、压缩、重试和恢复；不增加第二套执行循环。
- 文档集中在 `docs/`；源码附近的 README 只解释其开发工具或 fixture。
- 当前文档更新到使用指南与验证总览；阶段历史进入 `docs/archive/`。
- 原始产物留在本地；可分享的合成证据进入 `docs/evidence/`，记录来源、哈希和脱敏范围。
- 默认分支为 `dev`。提交采用 conventional commit 格式；不添加 Changesets。

## 打包

包保持 private，尚未发布 npm。tarball 包含编译产物、声明、三个入口、manifest、README、配置模板和 `docs/`；不包含开发脚本、测试、依赖或原始 artifacts。文档中的历史证据和示例代码不是 runtime 依赖。

本地检查和历史实测见 [验证总览](validation/README.md)。GitHub 托管与 npm 发布、hosted CI、生产质量验收分别记录；推送仓库不代表这些资格已取得。
