# API 契约

公共操作与输入输出的唯一来源为 [operations.json](contracts/v1/operations.json) 和 [schemas.json](contracts/v1/schemas.json)。这些是设计基线，宿主传输通过适配工单验证。目前运行的是原型预设，尚无工作台业务 API。

应用边界按操作索引验证输入和输出。Web 通过宿主认证及 Remote 访问；模型只见 `agent.suggest` 与 `agent.submit` 的受限公开输入；Host 用当前 ToolExecution 推导绑定。适配层从当前会话推导任务、身份及 requestId。用户决定不暴露给模型。无访问权与不可见资源可统一返回 NOT_FOUND，具体内部原因不写入模型输出。

- 写操作首先查授权与幂等键，再检查预期 revision 与状态。相同作用域、操作名、输入摘要和 requestId 返回原结果，摘要不一致返回 INVALID。
- 操作成功提交后的 revision 单调递增。REVISION_CONFLICT 后读取当前状态再确认修改。
- list 游标绑定工作区和排序，由 updatedAt、taskId 形成稳定排序。页面上限 100，同一页重复条目去重；跨页并发更新允许重新刷新。
- task.reconcile 只有可信宿主索引证明会话与 intent 归属一致时才绑定。丢弃 intent 仅结束本地意图，历史会话可以继续存在。
- agent 输入的产物 ID 与证据引用必须按当前 Run 解析。模型文本只能作为 model-claim，服务生成可信证据种类。
- task.decide 要求当前提交 ID，退回要求理由；漂移及缺少必要证据时返回明确错误。接受记录由应用服务注入已认证用户身份。

公共改变必须更新契约版本和兼容说明。客户端类型、运行时校验、测试样例使用上述来源生成或直接读取。

提交的选择为 `latest-presentation` 或 `files`。后者必须提供 paths，前者不得提供 paths。输入不携带内部产物或证据 ID。Host 从当前阶段且晚于上一提交的成功展示解析版本引用。验收接受可由 owner 提供 confirmedCriteria，逐项确认本次提交的条件，活动不写入原提交证据，而作为决定的 reviewEvidence 持久化。退回必须提供理由，不接受条件确认。
