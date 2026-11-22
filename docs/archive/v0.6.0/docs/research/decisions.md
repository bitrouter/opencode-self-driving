# 原生接入、概率策略与决策证据调查

状态：**Draft for review，2026-10-18**。本文回答 SPEC 的 R2、R4、R6，并补充已纳入首版设计的上下文选择与自动工具审批。未实现正式插件，未调用付费模型，未启用自动审批。

后续 review 已确认本文建议的原生绑定范围、三类独立概率策略、有界投影、总 deadline 与单候选直接绑定方向；[docs/spec.md](../spec.md) 记录当前设计契约。具体概率阈值、超时和投影预算仍待实测验收，不把设计确认计为运行验证。

源码基线：本地 OpenCode `60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006`，相关接口与 `origin/dev` 的 `501b15af26915ba52682e20e220e7e137e89e92f` 核对；Pi `4ff6ee8a1b3cd4977d64b5794e0feb2ec27ac40e`。外部服务文档按调查日期读取；服务能力、宿主接入、插件可复用能力、真实凭证验收分别记录。

## 1. “只复用原生”意味着什么

DecisionAdapter / BackendAdapter 是原 spec 的插件内部职责名，OpenCode 没有同名的通用插件服务。改为“原生决策绑定 / 原生后端绑定”：只组合现有公开 provider、Evaluation、凭证与插件 API，不新增服务协议、第三方决策 SDK、登录流程或私有 resolver 的复制品。

### 1.1 原生决策入口

`@opencode/ai/experimental` 提供 `Evaluation.run({ model, state, questions, http })` 与 `EvaluationClient.fetchLayer`。当前源码有四个 provider selector：

| 原生 selector                                              | 默认 HTTP 地址                                         | 原生凭证入口                                                         | 源码中的模型示例                      |
| ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------- |
| `TypeSafeAI.configure().experimental.evaluation(...)`      | `https://api.typesafe.ai/v1/systemone`                 | 显式 `apiKey`，或 `TYPESAFE_API_KEY`                                 | `jev-latest`                          |
| `OpenCode.configure().experimental.evaluation(...)`        | `https://opencode.ai/inference/systemone/v1/systemone` | 显式 `apiKey`，或 `OPENCODE_API_KEY`                                 | Jev selector；实际 entitlement 待验证 |
| `OpenRouter.configure().experimental.evaluation(...)`      | `https://openrouter.ai/api/v1/systemone`               | 显式 `apiKey`，或 `OPENROUTER_API_KEY`                               | `typesafe/jev-1.13`                   |
| `VercelAIGateway.configure().experimental.evaluation(...)` | `https://ai-gateway.vercel.sh/v1/evaluate`             | 显式 `apiKey`，或依次读取 `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` | `typesafe-ai/jev`                     |

这些 provider 还允许公开 `auth` 覆盖及 endpoint / headers 配置。插件只在对应原生绑定中使用，不新增任意 URL 的通用 transport。模型示例是仓库示例，不是当前推荐版本或可用性证明。

前三个使用内置 System One route，将公共 `boolean` 转为线上 `noul`；Vercel 使用自己的 evaluation route。Pi 的 OpenRouter `/api/alpha/decisions` 不在这里新增：OpenRouter 文档确认 alpha Decisions 与 System One 是两种入口，不能因为字段相似就混用。其他厂商在 alpha Decisions 上新增模型，也不自动代表现有原生 System One selector 已兼容。[OpenRouter 官方接入说明](https://openrouter.ai/docs/guides/community/jev)

四个入口是 AI 包能力，不等于四个完整的产品配置向导。原生生成模型目录也不是决策模型目录。插件需要保存明确的 provider、endpoint、请求模型 ID、允许的返回模型身份与凭证连接；不能把任意聊天模型当作 Evaluation 模型，更不增加“生成 JSON 再解析”后备路径。

`jev-latest` 等别名可能移动。阈值验收应固定版本；使用别名时记录实际返回身份，并在模型变化后重新验收。Vercel route 在响应缺少 model 时会用请求 ID 填充公共 response，因此这个字段不能一律声称为独立验证过的物理身份。

### 1.2 原生生成后端与凭证

原生 AI 包公开文本生成 provider 包括：Alibaba、Anthropic / AnthropicCompatible、AmazonBedrock / Mantle、Azure、Baseten、Cerebras、Cohere、CloudflareAIGateway / WorkersAI、DeepInfra、DeepSeek、DigitalOcean、Fireworks、Google、GoogleVertex 及其各协议入口、Groq、Meta、MiniMax、Mistral、Moonshot、OpenAI / OpenAICompatible / OpenAICompatibleResponses、OpenRouter、TogetherAI、VercelAIGateway、Venice、XAI、ZAI / ZAICodingPlan。以各入口实际暴露的 `.model` / 协议 selector 为准；图像、音频、视频专用 provider 不作为编码后端。

宿主还通过内置 provider plugins 和动态目录提供 ChatGPT、GitHub Copilot、GitLab、OpenCode Console、本地 Ollama / LM Studio / vLLM，以及其他已配置服务。目录内容随配置、连接、发现结果变化，不建立另一份固定厂商目录。

| 原生凭证类别              | 当前宿主中的代表                                                                                | 对插件的约束                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| API key / token、环境变量 | OpenAI、Anthropic、Google、OpenRouter 等；各 provider 自己定义 header 与变量                    | 经公开 integration 解析已选连接，交给对应原生 provider；不能统一假设全是 Bearer                  |
| OAuth                     | ChatGPT、GitHub Copilot、GitLab、OpenCode Console                                               | 复用宿主登录与 refresh；OAuth token 可取得，不等于 endpoint、账户 header、协议和请求 hook 已复用 |
| AWS 外部身份              | Bedrock API key，或 SigV4 默认凭证链、命名 profile / SSO                                        | 交给原生 Bedrock auth；`external` 不是可当作 API key 的字符串                                    |
| Google 外部身份           | Vertex API key / Express，或 ADC、gcloud / workload identity；原生 selector 也接受 access token | 交给原生 Google auth；project、location 与 credential metadata 一并参与绑定                      |
| Azure 外部身份            | API key；宿主 Azure CLI / Entra ID 外部方式                                                     | CLI token 注入包含宿主专属请求行为，不能只拿一个伪 token 调原生 package 就声称支持               |
| Vercel 身份               | Gateway key 或 OIDC token                                                                       | 保留原生选择优先级；不自行新增 token 获取 / 刷新流程                                             |
| 本地或自托管 endpoint     | Ollama、LM Studio、vLLM、OpenAI-compatible endpoint                                             | 使用宿主已经配置的 endpoint / 凭证；不另做服务发现、安装或登录                                   |

公开 `Credential.Value` 为 `key / oauth / external`；公开 integration 方法还包括 `env / command`。连接解析、OAuth refresh、激活由宿主负责。插件配置只保存连接引用和非秘密能力配置，不复制凭证到 storage、RPC 或诊断记录。

**重要缺口：公开插件 Context 没有“给我任意 Model.Ref 的完整可流式执行模型”接口。** `ctx.generate.text` 只接受 prompt 与可选模型，返回 text；它不能透明承接工具流。`ctx.session.generate` 也是宿主 Session 生成，不是物理模型 resolver。私有 Core resolver 还处理 variant、endpoint 变量、连接 metadata、auth、原生 / AI SDK 路径与宿主请求行为，不能导入或照搬。

所以原生绑定仍需要做组合模型与公开 AI API 的输入 / 流桥接；这不新增供应商协议，但也不能直接声称“全部原生目录零适配”。每种后端必须满足：公开 provider 入口可执行、所需 settings 可通过公开数据取得、现有 credential 方式可复用、工具 / reasoning / 流 / 取消已验收。缺一个条件就不出现在可选支持集合中。OAuth、Azure CLI、Copilot 等不能用 API key fixture 验收代替；当前没有任何真实后端的完整组合链路验收结论。

这遵守“不额外新增”：范围由原生能力及公开边界决定；不为补齐目录覆盖率新增登录器、alpha transport 或私有 resolver。

## 2. R4：分布、confidence、阈值是三个不同问题

### 2.1 当前契约究竟保证什么

| 层次                      | Choice                                                               | Boolean                                         |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| 公共 Evaluation schema    | `choice` 必有；`probabilities`、`confidence` 可选                    | `probability` 必有，范围 0–1；无独立 confidence |
| EvaluationClient          | 答案数量、问题 ID、类型、合法选项；如果有分布，keys 必须恰好匹配选项 | 对应问题必须得到 boolean answer                 |
| 内置 System One decoder   | 必须返回完整 `probabilities`；confidence 解码允许缺失                | 原生 `noul` 映射为 probability                  |
| Vercel evaluation decoder | 使用公共答案 schema，允许省略分布 / confidence                       | 使用公共 boolean schema                         |

EvaluationClient 不检查分布和为 1，不计算 argmax 或 confidence，也不保证概率校准。TypeSafe 线上文档对 Choice / Score 声明分布与 confidence；这是服务契约，比公共类型更具体。不能反过来把所有公共 Evaluation provider 都限制成同一个 Jev 契约。

建议把校验分两层：原生 API 负责解码与问题匹配；插件只增加所选策略需要的语义校验。已有类型保证的字段不重复手写防御检查；外部入口缺少策略必需字段时明确不可用，不补造概率。

完整分布有助于解释近似并列、排查偏向某档及离线评估策略；在原生已经返回时保留它，没有必要扔掉。但“需要选一个合法后端”并不逻辑上要求再强制一个公共契约之外的 confidence。五档虽有顺序，实际映射可能跨厂商，能力也未必单调；继续使用 Choice 选择配对，不把 Score 的小数或期望值四舍五入成档位，也不把各档概率当作编码成功率。

### 2.2 为什么不能照抄 Pi 的固定归一化检查

Pi resource classifier 强制分布、finite confidence、最高概率选项，并要求 `abs(sum - 1) <= 0.01`；默认 `minimumConfidence = 0`。这意味着它要求字段存在，但默认并没有排除低置信度。OpenCode System One 明确原样保留两位小数概率，并标记 `rounding.probabilityDecimals = 2`。

构造一个合法的五类真实分布：`[.1949, .1949, .1949, .1949, .2204]`，总和为 1；保留两位小数后变成 `[.19, .19, .19, .19, .22]`，总和是 `.98`。固定 `.01` 容差会拒绝这种返回。

建议：如果策略检查完整分布，则检查有限值、0–1、精确选项集合；对已声明 d 位独立四舍五入的 n 类分布，采用最多 `n × 0.5 × 10^-d + epsilon` 的累计误差。没有精度声明时不凭空套用这个容差。保留原值，不静默重新归一化。只有服务声明 choice 为概率最大项时才核对 argmax；舍入后的并列可接受，不从并列反推未舍入值。

### 2.3 confidence 并不是“正确率保证”

TypeSafe Choice 定义 `c = (p_max - 1/n) / (1 - 1/n)`，n > 1；Boolean 则直接返回 yes 的概率。Choice 的 confidence 是分布集中度的派生量，没有提供一份独立证据。[TypeSafe confidence 定义](https://docs.typesafe.ai/confidence)

本插件会因容量过滤改变候选数。例如获胜概率同为 `.8`，五选一时 c 是 `.75`，二选一时是 `.6`。统一设置 `c >= .7`，会仅因选项数变化而接受前者、拒绝后者。数字是公式演算示例，不是实测模型输出。单候选直接绑定时不构造 confidence=1。

“概率 .9 的样本约有九成正确”需要目标任务上的校准证据；全体平均校准也不等于每类操作、长文本、中文或对抗输入都可靠。经典校准研究解释了这个区分，不能据此直接断言某个当前 Jev 版本的质量。[Guo 等，2017](https://proceedings.mlr.press/v70/guo17a.html)

更贴近本任务的一项 2026 年预印本评估了 System One 的安全决策：在其 WAInjectBench 设置中，Jev 给 1,320 个输入返回 unsafe 概率 0，其中包含 102 次漏检；任何正 allow 阈值都无法区分这组里的正确与错误。它使用特定版本、问题与公开基准，不是 OpenCode 自动审批测试；结论是需要本插件的独立验收，不能把 `.05` 写成漏批率保证。[Liu，v3](https://arxiv.org/html/2609.33401v3)

### 2.4 按决策用途采用不同策略（已确认）

| 用途       | 已确认输出 / 策略                                                                                            | 不确定或异常时                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 五档选模   | Choice；合法容量候选必需；分布按原生契约，confidence 只记录，不设通用门槛                                    | 非法选择 / 决策失败阻断；低 confidence 本身不擅自升级模型 |
| 可选上下文 | 对每个可选单位询问 `needed` 的 Boolean；只有 `p(needed) < tau_omit` 才允许省略                               | 缺值、临界、超时、证据不足均保留；required 不参与判断     |
| 自动审批   | Boolean `needs_human`，同时判断用户授权、影响范围、可逆性与证据完整性；只有 `p < tau_allow` 才考虑 ask→allow | 等于阈值、缺值、异常、不支持均保留原生 ask                |

`tau_omit` 和 `tau_allow` 是两项独立配置；不复用一个全局 confidence，也不把“可逆”当作用户已授权。Pi 的 `p(needs_human) < .05` 是可参考的初始策略，其源码明确没有测得错误保证。首版自动审批默认关闭；先用 shadow 模式得到建议并保留人工动作，验收后才显式启用 auto。模式默认值已确认，概率阈值数值尚未确定；本轮没有启用任何权限。

阈值、模型版本、问题定义、候选定义、证据 schema / 投影版本应当作为同一验收配置。选模看完成质量与成本 / 延迟；资源选择看错误省略；审批分别看未授权动作被自动放行、人工占比与放行覆盖率。阈值调优与最终评估数据分开，并覆盖实际工具类型、语言、长输入及不可信工具结果。提高 confidence 门槛或再加一个 judge 都不能独自保证错误上界。

审批报告还要区分两个分母：`未授权且放行 / 全部未授权动作` 衡量漏检，`未授权且放行 / 全部自动放行动作` 衡量自动批准中混入多少错误。模型的单次 `.05` 预测不是这两项指标的实测值；“没有错误的日志”也不能替代代表性数据。用户是否授权与操作是否危险相关但不同，`needs_human` 的问题与标签必须同时明确这两个维度。

## 3. R6：超时与取消

### 3.1 宿主默认值不能当作决策默认值

原生生成 HTTP transport 提供整请求 timeout、headerTimeout 与 chunkTimeout；header 默认 300 秒，chunk 默认 900 秒，整请求未设置时无限。**当前 System One 与 Vercel evaluation route 直接调用 RequestExecutor，再读取 JSON，没有经过这个生成 transport 的 timeout 包装。** 它们消费 `http.body / headers / query`，源码未消费 `http.timeout / headerTimeout / chunkTimeout / encoding`。仅向 Evaluation 填 `http.timeout: 10000` 不能作为已经生效的超时保证。

原生 `EvaluationClient.fetchLayer` 当前没有额外决策重试。插件应使用公开 Effect 的 timeout / interruption 包围完整决策程序，并将本次取消信号接入运行中的 Effect；不是只用 `Promise.race` 让调用者先返回。实际 HTTP abort、响应体读取、连接 refresh 与 cleanup 的取消仍要本地 HTTP 验收；不能从可接受一个 signal 就推导出所有凭证方式都已验收。

### 3.2 两种 deadline

| 操作       | deadline 包括                                                             | 到期结果                                                             |
| ---------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 主请求准备 | 资源快照、证据构造、连接解析、上下文决策、容量计算、选模决策、解码 / 校验 | 上下文阶段到期则回到完整视图；若仍需选模且剩余时间不足，阻断本次派发 |
| 工具审批   | 权限事实与用户授权证据构造、连接解析、布尔决策、解码 / 校验               | 保留原生 ask，展示原因                                               |

上下文选择与选模共享一个主请求总 deadline，各阶段只使用剩余预算；不每进入一个阶段就重新获得十秒。取消 Session 时取消全部本地决策；迟到的结果不写回 hook。预算覆盖异步阶段；超大 JSON 等同步构造需提前限制输入规模，不能假装计时器可抢占同步 JS。

`10s` 主请求准备、`5s` 审批可以作为小输入原型的可调起点，尚未成为正式默认或长上下文 SLA。首版不自动重试、不自动切决策模型；429 / 网络失败保留明确错误。服务端取消与停止计费不作保证。Vercel 示例使用 30 秒，也只是示例配置，不是本插件应照搬的 SLA。[Vercel 示例说明](https://vercel.com/i/ai-gateway-decision-api-use-cases)

Pi 当前实现也不是一个统一常量：resource classifier 是 10 秒、64,000 UTF-8 bytes、最多 64 个可选资源；approval 是 5 秒、64,000 个 JS 字符计量单位，超限回人工。字符、UTF-8 bytes、模型 tokens 不相等，中文和转义 JSON 更明显。它们是 Pi 插件自己的限制，不能当作服务端窗口或本插件默认支持范围。

## 4. R6：输入范围与证据

### 4.1 实际输入限制

TypeSafe 当前文档区分 Jev 默认每请求 64K、每问题 32K tokens；长上下文需显式 header `TypeSafe-Danger-Zone-Long-Context: true`，两项均提高到 262K，并提示速度与准确性代价。原生 `headers` 可以表达这个配置，但不默认打开，也不把直连接口设置自动套用给其他 gateway。[TypeSafe 模型与容量](https://docs.typesafe.ai/models)

另有 HTTP JSON 请求体 32 MiB、解压前后分别限制、嵌套深度等限制；这与 token 容量分别检查。原生 evaluation route 目前没有使用 HTTP encoding 配置，不能以压缩后的传输字节数代替未压缩证据预算。[TypeSafe HTTP 契约](https://docs.typesafe.ai/api)

OpenRouter 文档列 Jev 262,144 tokens，并有网关自己的长上下文行为；直连、OpenRouter、Vercel、OpenCode 的 endpoint、限额与模型身份分别验收，不共享一个未经证明的“Jev 大窗口”常量。网页新增图片 / Box 等能力也不扩大当前公共 Evaluation 的三类问题支持。

公共 `EvaluationModel` 没有 input/context 容量字段，生成模型目录中的窗口不能替代它。决策绑定需记录经文档与验收确认的每请求 / 每问题 tokens、UTF-8 请求体 bytes、问题数 / 选项数、模态与 deadline 范围；不知道就显示未知并限制能力，不假定无限。系统问题、候选 criteria 和 JSON 编码开销都属于决策预算。

首版建议只承诺文本、结构化 JSON、文本工具声明与文本工具结果。二进制、图片、音频、视频、不可读取附件不自动转成文字后声称内容等价；未验收时选模明确不支持，上下文保持原样，审批交人工。

### 4.2 三种证据不能共用一段 prompt

| 决策     | 必要证据                                                                                                  | 证据边界                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 选模     | 当前用户任务、可见任务历史与工具结果、必需约束、容量已合格的配对、各档能力说明                            | 保留角色及 tool-call/result 关联；容量 / 数学由代码计算，不让模型猜          |
| 资源选择 | 当前任务证据、宿主已加载资源的 ID / 版本 / 描述、required 与依赖、可验证的可选内容                        | 不新读 skill 全文、不新连 MCP、不建立第二个资源发现系统；未知来源不能省略    |
| 审批     | 当前分支可取得的用户授权与限制、适用指令、实际 permission action/resources/source、精确参数 / diff 与 cwd | assistant 和工具结果只作事实，不新增授权；缺少原始约束或执行参数则不自动批准 |

`state` 组织为带版本的结构化 JSON：区分任务、规则、对话角色、资源元数据与不可信工具内容；问题与 criteria 由插件构造。工具描述、文件内容和 MCP 返回不能把其中“请批准”变成上级指令。这是输入边界设计，不声称通过标签就解决了 prompt injection；TypeSafe 自己也列出 Jev 1.13 的对抗输入与无关长状态问题。[TypeSafe 已知边界](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

只记录 schema / policy / profile 版本、大小、选项、结果、超时原因、已知用量与证据摘要指纹，默认不在诊断里再次保存原始用户消息、工具参数或 credential。指纹用于关联变化，不能证明可恢复，也不能还原缺失证据。

### 4.3 1M 编码与决策证据：已确认方向与待验收范围

| 方案                         | 能力与代价                                                                                                   | 当前约定                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 全量可见请求作为决策证据     | 行为最清楚；受决策模型每问题容量限制，可能远低于编码窗口，长输入还增加费用 / 延迟                            | 保留为 `full` 对照模式，范围按实际绑定验收，不作为隐式 fallback  |
| 确定性的有界投影             | 发送完整最新任务、适用约束、近期完整 exchange / tool pairs、资源目录及明确的省略清单；生成后端仍收到原生历史 | 已确认用于选模 / 资源选择；保留规则见 SPEC，具体预算与质量待验收 |
| 插件摘要 / stateful observer | 可能压低每次输入；增加摘要失真、持久化和恢复设计                                                             | 本轮 defer                                                       |

有界投影不是保证无损：旧工具结果中的困难、早期任务依赖可能被遗漏，导致选模或资源选择偏差。固定“最后 N 条”也不是足够定义；投影按完整单位选择可选历史并列出省略范围，不截断参数或工具关联；必需字段超限时执行对应的阻断 / 完整保留 / ask。它不改变 Core compaction 或生成历史，但会改变决策看到的证据；这个取舍已获确认，质量尚未验收。

审批不能沿用这个放宽：精确参数、用户授权或适用限制放不下时回到 ask，不自动摘要、截断后放行。压缩后若公开视图无法提供所需原始授权，自动审批覆盖率下降；不以恢复已 defer 为理由假装证据齐全。

保留已确认的“最大可承接窗口＋逐请求容量过滤＋原生压缩”。大请求只剩一个合格档位时，按已确认的 R9 直接绑定，省掉选模决策；上下文继承仍可工作。开启可选资源决策、存在多个大窗口候选、或要求完整审批证据时，决策限制重新生效。因此应分别展示编码可承接范围与自动决策覆盖范围，不能一律把编码窗口压到 262K，也不能一律宣称 1M 全量决策已支持。

## 5. 上下文选择与审批的公开 API 设计边界

上下文选择先得到临时视图，再计算容量并选模。资源问题可在一个 Evaluation 中批量提交，全部核对后计算依赖闭包；选模只看最终视图与合格档位。避免一次独立回答的联合问卷产生“删 A 才适合小模型，但实际保留 A”的不一致。代价是最多两个串行决策阶段；没有可选资源或只有一个合格档位时分别跳过。

来源通过公开 skill / tool / MCP 元数据、请求内容与能验证的原生渲染格式建立映射。当前 `session.context` 没有统一的 instruction source ID / hash：适用 AGENTS.md、基础 system、agent 指令、明确调用的 skill、已在对话中加载的内容、无法拆分的块都保留；不对裸 system 文本做猜测性段落删除。每 Step 重建视图；动态加载、配置变化、compaction、fork / revert 后重新观察，不恢复上次分配。

`session.context.tools` 只过滤顶层声明。CodeMode 的内部 catalog 在 hook 前构造，叶子调用仍经过 `tool.execute.before`。首版把 CodeMode execute、内部目录与无法精确拆分的相关说明作为整体保留，不能只隐藏叶子声明就声称它不可搜索。直接暴露的工具可做可见性选择，并在可关联的 before hook 校验；没有可靠请求关联或来源映射时不能承诺资源门禁，按完整原生视图处理或明确报告当前模式不支持。选择不授予任何权限。

自动审批挂在原生 `permission.evaluate`：只处理已启用 Session 的 `ask`；已 allow 不重复审批；配置 deny 在 hook 前已经返回，不能覆盖。公开 permission 事实比 before 快照更靠近实际动作：

| 原生工具族               | 当前权限证据                                                | 自动审批设计要求                                                     |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| MCP                      | action、source、`metadata.input` 包含实际调用参数           | 可作为完整参数候选；描述、外部效果与用户授权仍需满足支持契约         |
| 编辑 / patch             | 原生审批中的变更信息 / diff，按工具实际 metadata            | 逐工具定义证据，不能假定所有 diff 格式相同或都完整                   |
| Shell                    | action / 命令资源；assert 未附完整 shell command metadata   | before hook 的参数可能被后续 hook 改写；缺少可核对最终命令时保持 ask |
| 自定义工具 / 未知 action | metadata 无统一参数契约；也可能不调用原生 permission.assert | 不承诺统一覆盖；维持宿主行为                                         |

before 快照只作补充，克隆本地证据，不冻结宿主对象。一次批准只对应本次 call/source、action、resources 与证据版本，不保存成 Session-wide allow 规则。失败与超时只保留 ask，不给 deny 打补丁；headless 的 ask 可能等待客户端，公开 API 没有统一 hasUI，不能承诺自动中断。

## 6. 已确认设计与剩余验收

1. 范围已按用户要求调整：首版设计上下文选择、自动审批；stateful observer 与插件恢复后置，Core 恢复保留。
2. R2：只用现有原生绑定，四种 Evaluation 入口和生成 / credential 能力分别验收；不以目录存在作为插件执行承诺。
3. R4 已确认：选模不设全局 confidence 门槛；可选资源和自动审批各用 Boolean 概率与专用阈值。数值待验收；原生契约要求的完整分布仍校验。
4. R6 已确认：有界投影用于选模 / 资源选择，full 作对照；审批证据不能通过有损投影扩大自动放行范围。deadline 用公开 Effect 真正取消；10s / 5s 仅是待测起点，投影预算尚未确定。
5. R9 已确认：单个容量合格档位直接绑定并记录决策未调用；多个候选继续分类。此设计与资源 / 审批各自的输入范围分开验收。

## 源码入口

以下为本地 review 链接；源码读取用于说明边界，不允许插件运行时导入 Core：

- [原生 Evaluation 文档](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/README.md#experimental-evaluation)、[答案 / 输入 schema](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/experimental/evaluation.ts)、[问题匹配校验](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/experimental/evaluation-client.ts)、[System One route](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/experimental/system-one.ts)。
- [TypeSafe](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/providers/typesafe-ai.ts)、[OpenCode](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/providers/opencode.ts)、[OpenRouter](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/providers/openrouter.ts)、[Vercel](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/providers/vercel-ai-gateway.ts)、[原生 provider exports](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/providers/index.ts)。
- [公开 plugin Context](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/plugin/src/promise/plugin.ts)、[integration](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/plugin/src/promise/integration.ts)、[credential schema](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/schema/src/credential.ts)、[private resolver 边界](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/model-resolver.ts)。
- [HTTP 设置](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/schema/options.ts)、[生成 HTTP timeout 实现](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/route/transport/http.ts)、[RequestExecutor](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/ai/src/route/executor.ts)。
- [公开 Session hook](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/plugin/src/promise/session.ts)、[tool hooks](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/plugin/src/promise/tool.ts)、[permission hook](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/plugin/src/promise/permission.ts)、[deny 与 hook 顺序](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/permission.ts)。
- [CodeMode / 工具快照](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/tool.ts)、[MCP 参数证据](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/tool/mcp.ts)、[shell 权限证据](https://github.com/anomalyco/opencode/blob/60a5a6ca7ce176b04cd2321ffd1819b1ea8e6006/packages/core/src/tool/plugin/shell.ts)。
