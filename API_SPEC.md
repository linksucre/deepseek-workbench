# API 契约

公共操作与输入输出按接口版本以契约文件为唯一来源。

| 版本 | 操作索引 | Schema | 用途 |
| --- | --- | --- | --- |
| v1 | [operations.json](contracts/v1/operations.json) | [schemas.json](contracts/v1/schemas.json) | 冻结的原始设计基线 |
| v2 | [operations.json](contracts/v2/operations.json) | [schemas.json](contracts/v2/schemas.json) | 工作台命令及原生工具接入基线 |

v2 的命令路径为 `/workbench/v2/command`。此前联调包在 `/workbench/v1/command` 上使用与 v2 对应的请求形状。部署时按 [版本与兼容设计](docs/design/WORKBENCH-API-VERSIONING.md) 核对旧调用方、历史会话和端点迁移范围。

应用边界按操作索引验证输入和输出。Web 通过宿主认证及 Remote 访问；模型只见 `agent.suggest` 与 `agent.submit` 的受限公开输入。适配层从当前会话推导任务、身份及 requestId。用户决定不暴露给模型。无访问权与不可见资源可统一返回 NOT_FOUND，具体内部原因不写入模型输出。

- 写操作首先查授权与幂等键，再检查预期 revision 与状态。相同作用域、操作名、输入摘要和 requestId 返回原结果，摘要不一致返回 INVALID。
- 操作成功提交后的 revision 单调递增。REVISION_CONFLICT 后读取当前状态再确认修改。
- list 游标绑定工作区和排序，由 updatedAt、taskId 形成稳定排序。页面上限 100，同一页重复条目去重；跨页并发更新允许重新刷新。
- task.reconcile 只有可信宿主索引证明会话与 intent 归属一致时才绑定。丢弃 intent 仅结束本地意图，历史会话可以继续存在。
- v2 的用户和 Agent 提交从当前 Run 选择最近一次原生展示或指定文件。Host 核验选择范围并生成产物版本和可信证据。模型文本只能作为 model-claim。
- task.decide 要求当前提交 ID，退回要求理由；漂移及缺少必要证据时返回明确错误。接受记录由应用服务注入已认证用户身份。

公共改变必须更新契约版本和兼容说明。客户端类型、运行时校验、测试样例使用上述来源生成或直接读取。
