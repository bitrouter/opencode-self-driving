# 安装与兼容范围

包 `0.6.0-dev.0` 保持 private，尚未发布 npm。验收基线为 macOS、Bun 1.4.2、OpenCode V2 `2.0.32` 源码 commit `501b15af26915ba52682e20e220e7e137e89e92f`。不声明兼容整个 2.x。OpenCode 1.x 的旧插件 API 不受支持；隔离验证无需替换现有客户端。

## 从源码生成并安装

在包目录运行，确保 Bun 1.4.2 位于 PATH：

```sh
bun run dev:link /path/to/dependency-installed/opencode
bun run check
npm pack --ignore-scripts
```

在独立的插件管理目录安装生成的 tarball，然后把已安装包目录的绝对路径加入兼容 V2 宿主的配置：

```sh
npm install --ignore-scripts --legacy-peer-deps /absolute/path/opencode-self-driving-0.6.0-dev.0.tgz
```

```json
{
  "plugins": [{ "package": "/absolute/plugin-manager/node_modules/opencode-self-driving" }]
}
```

`--legacy-peer-deps` 跳过独立安装 peer；匹配版本的共享运行时由上述兼容宿主提供，本地验收使用相同方式离线安装。也可直接配置构建完成的源码包目录。配置的本地路径必须是目录。不要把 `server.js` / `tui.js` 单独复制到全局插件目录；宿主通过完整包发现入口、声明与共享运行时。

`@opencode/plugin@2.0.32`、`effect@4.0.1` 为必需 peer。`solid-js@1.9.15`、`@opentui/solid@0.5.17` 为 TUI 可选 peer，headless 不需要加载它们。server / TUI 都使用宿主提供的共享模块；产物不打包第二份 Effect、Solid 或 OpenTUI，也不依赖开发 checkout 的绝对路径。

## TUI 与 headless

加载保持 unconfigured。在已有 Session 中运行 `/self-driving config`，粘贴填好的 [profile](../examples/profile.json)，审阅并确认发布。`/self-driving on` 启用路由；`/self-driving policies` 分别启用资源和审批策略。原生 `model.list` 中的可用模型与 variant 才能通过选择器使用。配对的服务、凭证引用和所有预算必须明确填写。

Headless 使用同一份已发布配置和公开 RPC；完整示例见 [配置指南](configuration.md#headless-配置与使用)。缺配置时 enable 明确失败。审批保留 ask 时，按宿主行为等待客户端回复；本插件不新增无人值守批准策略。

配置通过 server plugin storage 以 Location 为单位保存。TUI 连接远程服务时，profile 的环境变量引用由 **server 进程** 解析；在客户端 shell 设置变量不会自动交给远程服务。可用的 native integration key 由宿主管理。不复制认证文件，不额外登录或刷新。

停用时运行 `/self-driving off`，等待当前执行结束后恢复原模型和 variant，并重置该 Session 的资源 / 审批策略。卸载从配置移除整个包目录并按宿主机制 reload；公开 storage 中的 profile 保留供以后显式使用。当前不提供删除宿主 storage 的私有清理工具。

## 开发客户端验证

完整包检查含离线 tarball 安装、真实 SDK / RPC、生命周期与生产 OpenTUI 组件的窄宽测试。从包目录运行统一终端验收：

```sh
bun run check
bun run smoke:tui /path/to/qualified/opencode
```

`smoke:tui` 需要 macOS / Unix 的 tmux，创建独立 HOME / XDG / 数据库和 tmux socket，用指定 V2 checkout 的 `dev:live` 连接独立服务。只向 loopback HTTP / MCP 发送测试请求，不连接现有服务，不更换全局客户端。报告、终端帧和 Session log 位于 `artifacts/<version>/tui-<timestamp>/`。脚本和 fixture 不进入 tarball。

真实 provider 验收另用源码目录的 `docs/qualification.md` 和 `bun run qualify`，必须有明确服务、模型、凭证引用及预算计划。loopback 通过不证明真实服务身份、概率校准、长窗口质量、费用或已安装客户端兼容性。
