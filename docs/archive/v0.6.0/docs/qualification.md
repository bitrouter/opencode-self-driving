# 阶段 5：有界真实接入验证

`bun run qualify` 是源码 checkout 的开发验收工具，不进入插件 runtime bundle。它通过已有公开 SDK / 插件 API 启动隔离 V2 宿主，加载已构建的正式插件，验证一个明确的 profile 和样本集。未新增 DecisionAdapter、BackendAdapter、登录方式或宿主 hook。

当前工具已用 loopback 端到端验证；真实 OpenRouter 接入部分通过，见 [实测报告](validation/openrouter-live.md)，本地工具结果见 [阶段 5 状态](archive/phase-5-validation.md)。`completed` 仅表示所配置探针完成，`quality` / `calibration` 始终保留为 `not-qualified`，不能凭一次连通性 smoke test 声明校准或编码质量合格。

模板的 `text-connectivity-literal-v2` 使用明确的字符级输出指令，`expectedText` 与严格比较方式保持不变。有界真实对照中，Nano 在新指令下 2/2 通过、原指令下 0/2 通过；每组仅两次，不能推导稳定成功率。原计划与失败记录保持独立，见 [修复验证](validation/text-remediation.md)。这项样例调整不保证任意用户指令的输出格式，也不调整 runtime 路由或模型池。

## 配置与运行

实际文件修改任务使用独立的 [coding-benchmark 开发脚本](../script/coding-benchmark/README.md)，不扩展本工具的探针 schema。该轮对照为负向结果，见 [编码任务报告](validation/coding-task-live.md)。

1. 从 [qualification.json](../examples/qualification.json) 复制一份计划。替换所有模型和 endpoint 占位符，填写每个预算。模板中的零值会被拒绝，不是正式默认值。
2. 使用原生目录中可用的 provider / model / variant。Decision model 必须支持所选原生 Evaluation 协议，不能因为是普通聊天模型就假定它支持 Choice / Boolean。所有接受的 response model 名称需要明确列出。
3. 凭证只写环境变量名。profile 的 env 引用直接使用该变量；integration 引用通过 `credentials: { integrationID: "ENV_NAME" }` 将已有 key 经公开 `credential.create` 导入本次临时宿主。只有当前支持的 key；不读取真实 OpenCode auth 文件、数据库、已有 Session 或 OAuth / external connection。
4. 使用已验收的 Bun `1.4.2` 和 OpenCode V2 开发依赖，从本目录运行：

```sh
bun run build
bun run qualify --plan /path/to/reviewed-plan.json --out artifacts/0.5.0-dev.0/preflight.json
bun run qualify --plan /path/to/reviewed-plan.json --out artifacts/0.5.0-dev.0/provider-run.json --execute
```

无 `--execute` 时只做 schema、凭证引用和公开目录 / 容量预检，provider HTTP 转发数为零。缺凭证即 blocked；不尝试匿名调用。已存在的报告路径会拒绝覆盖；重跑须提供新路径。失败报告的 CLI exit code 非零。

`endpoints.decision` 与每个 `endpoints.backends.<backend>` 是显式批准的原生 base URL。支持 HTTPS，以及本地 fixture 的 loopback HTTP；不接受 URL 凭证、query 或 fragment。同一 provider 不能指向多个不同 endpoint。预检只启用已有目录定义，不编造新模型、窗口、capability 或 package。

例如，本次宿主中 OpenAI 原生默认的 transport / native compaction 配置不在当前 HTTP + summary 绑定范围，预检明确拒绝。package 也必须符合已有支持集。工具不会改写这些语义或复制一份假容量绕过；普通插件仍保持既有支持范围。

## 调用边界与预算

工具使用 loopback relay 转发原生 factory 已序列化的 HTTP；不是另一个模型适配器。公开 provider / model settings 和 decision baseURL 指向 relay，预检再核对实际配对生效的地址，variant 覆盖导致绕过时拒绝执行。转发只允许计划中解析出的物理模型；不跟随 redirect。

| 字段               | 约束                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `maxRequests`      | 全部实际转发的模型 HTTP 请求数，包含资源、选模、审批、生成与辅助调用；并发调用共同计数 |
| `maxOutputTokens`  | 每次生成请求的输出上限；profile.outputTokens 不得超过它                                |
| `maxDurationMs`    | 整次子进程运行的时间上限；到期取消，父进程另有最多 5 秒清理宽限，期间不再授权新调用    |
| `maxInputBytes`    | 累计转发的请求 body 字节上限，发送前检查                                               |
| `maxResponseBytes` | 累计接收响应 body 的上限；超过就停止读取并取消上游                                     |
| `maxStepsPerCase`  | 通过原生 agent.steps 限制每个样本的执行，另有全局请求数兜底                            |

Evaluation 协议没有统一的 max_output_tokens 参数，因此 `maxOutputTokens` 只约束生成；决策由请求数、完整输入字节、响应字节及总时间共同约束。响应字节限制在接收到 chunk 后检测，可能超过一个 chunk；它不能追溯限制已发生的远端输出或计费。这些预算不是金额保证，真实费用需服务端额度 / 账单确认。

遇到样本失败、文本不匹配或工具行为不匹配即停止后续样本。资源 / 审批失败的保守回退仍按正式插件策略执行，并计入同一总预算。公开 retry hook 将本次宿主的传输重试关闭，工具不自动付费重试、换服务或降档。取消传播经过 relay 到真实请求；远端停止与计费仍由服务控制。

## 工具与审批探针

本次宿主使用临时 HOME / XDG / config / database，禁用 models fetch 和文件 watcher，不读取项目配置。工具目录只留下 `qualification_echo`，所有其他工具权限 deny。MCP server 是本地无外部副作用的静态 echo，不连接用户已有 MCP server。

每个 tool case 显式给出预期 text 和 `needsHuman` 标签。人工 ask 的测试 consumer 只有在 action、完整 input 与预先授权的正例精确相符时才回复 once；其余 reject。这个回复会单独计入 `manualReplies`，不会计为插件 auto allow；不写 always。实际工具参数不匹配只返回静态错误，不存原始参数。负例允许没有实际工具执行；若模型根本没请求审批，报告不会虚构一条审批样本。

工具探针验证原生 invocation / result / 下一 Step；agent 仍由 Core 执行。默认例子只是连通性探针，不能代替真实编码任务、生产权限策略或全面工具副作用评估。

## 标签、指标与报告

计划在执行前固定，并写入 `planHash`。每个 case 指定 tuning 或 holdout；相同 prompt / 资源正文跨 split 会被拒绝。工具不会调阈值、合并两个 split 或用 holdout 反复选阈值。修改阈值后应使用新的独立 holdout，内容级重复检查不能代替人工审查近似重复和数据泄漏。

- `expectedText`：最后一条 assistant 文本 trim 后的精确比较，只是该探针的结果标签；没有标签就不计入完成率。
- `acceptableTiers`：执行前给出的可接受档位。空数组表示未知，不计为正确；它验证路由标签，不代表物理模型实际完成质量。
- `resources[].needed`：独立于 required 的人工标签。分别记录必需资源中的错误省略、已省略资源中的错误占比和省略覆盖率；shadow 使用 proposed，select 使用实际 omitted。
- `tool.needsHuman`：人工标签。报告审批漏检率、建议 allow 中错误占比、建议覆盖率、实际 auto allow 覆盖率、人工比例、概率可用率和实际人工回复次数。无概率 / 证据失败保留人工分支；没有观察的分母为零时 value 为 null。

每条请求记录类型、物理请求模型、HTTP status、字节数、输出上限和耗时。每个样本记录原生 Step 数、路由 / 资源 / 审批诊断、工具匹配和结果。有 expectedText 时另记 textComparison：assistant / 文本块是否存在、trim 后的 UTF-16 长度、实际 / 期望 SHA-256、首个差异的 UTF-16 offset 与两侧码点；不记录生成正文，也不放宽精确匹配规则。用量沿用原生已报告字段，未报告保持缺失，不补零。没有物理账单，不把组合模型估价当实际成本。耗时包含 relay 与隔离宿主开销，不是生产服务基准。

报告分别统计 loopback 与 provider 请求。它不保存请求 header、凭证、原始 prompt / output / tool input、上游错误 body、原始 Session log。临时数据库会包含本次合成历史及导入的 key，并在宿主关闭后删除；测试应使用合成数据。子进程原始 stdout / stderr 被丢弃，错误按阶段和静态原因报告。

full / bounded 对照可分别提交两个 profile 的独立计划与报告；探针不会自行改 profile 或额外生成未授权对照调用。真实 tokenizer、长窗口边界、代表性编码质量、阈值校准、服务价格 / 延迟比较仍需专门数据和显式 live 预算。本工具不自动授予这些资格。
