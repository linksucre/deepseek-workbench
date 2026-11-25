# 领域模块

归属 FR-002，输入形状来自 [公共契约](../../contracts/v1/schemas.json)。提供 Task 聚合与纯状态转移，校验必填验收、唯一 criterion、合法归属和提交不可变。接收调用者显式传入的时刻及 ID。

同一任务只能有一个有效活动 Run。只有当前 Submission 能验收。draft/ready 可编辑 brief；需要改变 active 任务的交付标准时需走明确变更流程。首版允许通过退回并创建关联任务修正。accepted/cancelled 为终态。失败返回稳定领域错误，应用层负责原子提交。
