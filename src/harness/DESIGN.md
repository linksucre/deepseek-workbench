# Harness 适配

归属 FR-004、FR-010、NFR-002。封装 workspaceRegistry、sessionController、原生权限与会话事件。通过启动兼容检查验证服务可用性，功能不足时返回 UNSUPPORTED。模型工具根据调用会话推导 Task/Run ID。

先确认现有 API 是否能保存可回查的创建标识。无法证明前次启动结果时进入待核对，用户只可绑定经验证的会话或结束启动意图。分发委派需独立工单，明确子任务范围、预算与写入隔离。Teams 只管理委派工作，任务验收仍由应用层处理。
