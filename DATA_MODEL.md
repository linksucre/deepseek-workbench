# 数据对象模型

接口字段和类型见 [v1 schema](contracts/v1/schemas.json) 与 [v2 schema](contracts/v2/schemas.json)。接口版本独立于持久化记录的 `schemaVersion`。本文件描述跨对象不变量，状态见 [DOMAIN](DOMAIN.md)。

Task 保存当前 brief、执行选择、状态和 revision。Run 从属于 Task，一次 active 状态的执行拥有唯一活动 Run。根会话必须属于对应工作区；子会话只有可确认的派生关系才纳入统计。Submission 关联 Run、briefRevision、交付版本及证据。Decision 绑定当前 Submission，由已认证用户提交。历史提交和验收记录只追加。

Artifact 用文件哈希或 Git 提交标记版本，外部链接缺少可证版本时显示未验证。内容哈希用于检查漂移，恢复旧内容依赖 Git 或显式快照。停用插件或会话删除后保留摘要与不可用标记。Evidence 的 criterionId 应对应提交时的验收条件。机器证据的值由原生结果或固定检查产生，模型描述和未验证证据不能自动满足机械条件。

用量保留提供方、模型、会话/调用稳定身份、记录来源和覆盖范围。取消与失败样本也须统计可得部分，缺失为 null。成本为带币种和费率日期的十进制字符串，避免浮点金额。各提供方字段在适配层规范化，缓存读写和未缓存输入按规定口径计算。
