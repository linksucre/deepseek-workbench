# 应用服务

归属 FR-003、FR-006、FR-009、NFR-001。读取当前身份及资源归属，再处理幂等与乐观并发，调用聚合并返回结果。定义 Repository、SessionGateway、EvidenceProvider、Clock 等端口。应用服务负责动作编排与失败语义。

Agent 建议记录来源与依据，用户覆盖后优先保留用户选择。接受提交时查当前版本和证据，处理缺失与漂移并记录用户身份。外部动作先写意图，完成后写绑定，结果未知置待核对。上下文索引只记录范围、来源和日期，按需从宿主读取。

[task-service.mjs](task-service.mjs) 集成领域命令与原生任务仓库。创建 ID 按用户、工作区和请求 ID 确定。写操作先确认调用者和资源归属，检查已记录回执并核对 revision，再获取文件或事件证据。回执重放返回当时的结果，记录与聚合在同一存储更新内。受信调用者只由 Host 边界创建；Agent 仅可对当前根会话对应任务建议和提交，验收必须由用户发起。确认根会话后，按 Run 初始化阶段 ID 和宿主事件游标；执行选择与修订号随阶段追加到同一任务记录。

reserveStart 只持久化意图，将任务置为待核对。原生创建由会话适配层负责，并确保同一意图只发送一次。bindConfirmedRun 仅接受适配层已核对的回执，并在提交时再次校验 intentId、预留会话 ID、工作区、preset 和 revision。持久化不足以证明来源时，适配层保持待核对。

`node tests/integration/application-smoke.mjs /path/to/built-deepseek-harness` 使用原生 JSON 后端和真实本地文件验证启动意图恢复、角色隔离、用户覆盖、幂等提交、漂移、退回和接受。会话绑定和事件切片是测试输入。DEV-012 仍需用真实 Web Host 再验证，并补齐原生可信回执、生产加载、提交工具和完整状态流转。

[host-runtime.mjs](host-runtime.mjs) 在 loopback Web Host 上挂载同源、仅 owner 可用的命令试验入口。HTTP 只做传输，命令输入和输出由 v1 公共契约校验。现有功能为创建、读取、编辑、就绪与用户选择。入口随试验 profile 显式加载，供 DEV-012 使用；最终传输与 UI 接入仍在评审范围。拒绝非 owner、跨源、非 JSON 或契约不匹配的请求；未认识的内部错误仅返回通用消息。

`host-delivery-smoke.mjs` 在同一真实 Web Host 上验证 owner 会话、无认证拒绝、跨源拒绝、契约拒绝、任务写入、重启读取及相同创建请求重放。此阶段的原生展示会话由测试直接创建，会话启动与提交还未从工作台命令入口接通。
