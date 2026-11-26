# API 契约

公共操作与输入输出的唯一来源为 [operations.json](contracts/v1/operations.json) 和 [schemas.json](contracts/v1/schemas.json)。工作台在本机 Harness Web 上挂载经过认证的命令入口，入参与响应依据契约校验。

应用边界按操作索引验证输入和输出。Web 通过宿主认证及 Remote 访问；模型只见 `agent.suggest` 与 `agent.submit` 的受限公开输入；Host 用当前 ToolExecution 推导绑定。适配层从当前会话推导任务、身份及 requestId。用户决定不暴露给模型。无访问权与不可见资源可统一返回 NOT_FOUND，具体内部原因不写入模型输出。

- 写操作首先查授权与幂等键，再检查预期 revision 与状态。相同作用域、操作名、输入摘要和 requestId 返回原结果，摘要不一致返回 INVALID。
- 操作成功提交后的 revision 单调递增。REVISION_CONFLICT 后读取当前状态再确认修改。
- list 游标绑定工作区和排序，由 updatedAt、taskId 形成稳定排序。页面上限 100，同一页重复条目去重；跨页并发更新允许重新刷新。
- task.reconcile 只有可信宿主索引证明会话与 intent 归属一致时才绑定。丢弃 intent 仅结束本地意图，历史会话可以继续存在。
- agent 输入的产物 ID 与证据引用必须按当前 Run 解析。模型文本只能作为 model-claim，服务生成可信证据种类。
- task.decide 要求当前提交 ID，退回要求理由；漂移及缺少必要证据时返回明确错误。接受记录由应用服务注入已认证用户身份。

公共改变必须更新契约版本和兼容说明。客户端类型、运行时校验、测试样例使用上述来源生成或直接读取。

提交的选择为 `latest-presentation` 或 `files`。后者必须提供 paths，前者不得提供 paths。输入不携带内部产物或证据 ID。Host 从当前阶段且晚于上一提交的成功展示解析版本引用。验收接受可由 owner 提供 confirmedCriteria，逐项确认本次提交的条件，活动不写入原提交证据，而作为决定的 reviewEvidence 持久化。退回必须提供理由，不接受条件确认。

`task.conversation` 返回已授权根会话最近的用户和 Agent 文本、执行状态和待交互类别。它不启动 Agent。`task.prompt` 由 Host 选择当前任务绑定的根会话，以任务、Run 和请求 ID 派生原生请求 ID，保留 native queue 语义。重启后原文重放返回既有回执，同 ID 改正文拒绝。新消息要求任务 active 并校验 revision。暂停和取消在原生停止得到确认后变更任务；恢复重验原会话并由后续显式消息唤醒。

`task.usage` 使用已授权任务的原生结算记录。返回提供方与模型分组、输入输出及缓存计数、完整性和覆盖说明。缺少计数时字段为 null；缺少费率、完整计数或统一币种时 estimatedCost 为空。配置软预算后附 softBudget，仅当估算币种一致且金额可比较时判断是否达到提醒。

## DEV-011 评审提案

[`task.delegate`、`task.reviews`、`task.review.reconcile`、`task.review.forward`](contracts/v1/operations.json) 由已认证的本机 owner 调用。派发输入提供问题与选中材料；同一次调用重放返回持久化审阅状态。核对只读取原生会话，依据已验证的第一轮结束事件更新状态。回送要求活动 Run 和已有完整摘要，复用 `task.prompt` 的显式排队及重放语义。设计依据见 [独立审阅](docs/design/M3-BOUNDED-REVIEW.md)。

部署侧可启用固定产物检查。`task.submit` 和模型提交工具使用相同的宿主检查入口，在原有 `Submission.evidence` 中返回 `machine` 结果。通过的结果满足对应条件，`confirmedCriteria` 继续承载本次用户确认。文件未入选时返回 `INVALID`，检查所见版本与候选版本不一致时返回 `ARTIFACT_DRIFT`。规则的作用域见 [固定产物检查设计](docs/design/M1-MACHINE-EVIDENCE.md)。

## 任务资料与阶段交接

`task.context.index` 接收任务 ID，返回授权来源的元数据及最近阶段交接。`task.context.load` 还接收已授权、已登记的完整 `SourceRef`，返回文件文本、原始网页地址、原生会话文本或提交版本。两者均为本机 owner 只读命令，经过同源认证和任务范围检查。读取期间任务修订改变返回 `REVISION_CONFLICT`，未知或不可读来源返回 `NOT_FOUND`。工作台根据索引条目按需加载正文。 [资料设计](docs/design/M2-WORKBENCH-CONTEXT.md)

审阅恢复使用已有的四个操作。对冷根的新派发返回 `INVALID_TRANSITION`，已受理的请求先用已有回执处理。显式核对与回送独立校验完整输入摘要，复用 ID 改变输入返回 `INVALID`。首次回送的预留和原生受理确认各推进一次 revision，返回结构继续为 `PromptReceipt`。原生结果未知时返回 `RECONCILIATION_REQUIRED`，使用同一输入核对。 [审阅设计](docs/design/M3-BOUNDED-REVIEW.md)
