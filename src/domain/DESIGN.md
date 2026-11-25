# 领域模块

归属 FR-002，输入形状来自 [公共契约](../../contracts/v1/schemas.json)。提供 Task 聚合与纯状态转移，校验必填验收、唯一 criterion、合法归属和提交不可变。接收调用者显式传入的时刻及 ID。

同一任务只能有一个有效活动 Run。只有当前 Submission 能验收。draft/ready 可编辑 brief；需要改变 active 任务的交付标准时需走明确变更流程。首版允许通过退回并创建关联任务修正。accepted/cancelled 为终态。失败返回稳定领域错误，应用层负责原子提交。

## 实现边界

[task.mjs](task.mjs) 暴露 createDraft 和 evolveTask。输入对象由边界契约校验，领域函数校验业务不变量，返回新的 TaskDetail。内部命令只接收已核验的会话、产物和审阅人，授权、幂等回执和启动意图保存在后续应用及存储适配。纯领域模块目前使用 ESM JavaScript，输出通过统一 JSON Schema 的回归验证。

提交后保存验收条件及交付版本快照。接受时每条条件均需可信的通过证据且无可信失败，每个产物须通过宿主版本核对。漂移或证据不足保持原提交与状态。受信观测的采集、文件并发与工作区归属由后续 Host 联调验证。

执行方式可以在 draft、ready、active 或 paused 更新，由受信调用者指定来源；用户已选定时，Agent 建议不得覆盖。历史记录由应用及持久化模块保存。

待核对状态允许记录宿主启动回执并增加 revision，状态保持 blocked。工作区、会话和回执的归属由应用服务及宿主适配核验。

用户可以在接受时逐项确认 Submission 的验收条件。确认随 Decision append，原 Submission 不被改写。确认不抵消可信的失败记录。

独立审阅仅在活动 Run 预留。完成事件校验同一 Run，在 active 或 review 接收 Host 验证的子会话 ID。Host 和存储回执负责原生亲缘核验及跨重启去重。

[context-link.mjs](context-link.mjs) 提供浏览器录入与宿主资料读取共用的 HTTP(S) 地址校验。它只检查和规范化字符串，不读取网页。

审阅回送仅可在活动任务预留。原生受理确认可在执行或验收阶段推进一次 revision。预留和确认使用独立的内部状态转移，审阅结论及提交证据保持原值。
