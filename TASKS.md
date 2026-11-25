# 开发任务

工单分支使用 `dev/<DEV-ID>-<slug>`。开始后在工单或本表记录负责人及分支，再修改代码。同一需求只能有一个主实施工单。状态为 planned、active、review、done；done 需附验收证据。下表拆分模块开发及依赖。

| 工单 | 需求 | 主责目录 | 依赖 | 状态 | 完成产物 |
| --- | --- | --- | --- | --- | --- |
| DEV-001 | FR-001 | src/preset | — | done | 预设及模拟模型集成通过，逐项验证预设必需工具 |
| DEV-002 | NFR-005 | scripts、contracts、docs、.github | — | done | 需求追踪、契约元模式、负例回归与受保护 PR 流程 |
| DEV-003 | FR-002 | src/domain | DEV-002 | review | 纯状态机与领域回归通过，待 API 集成复验 |
| DEV-004 | FR-004, NFR-002 | src/harness | DEV-003 | planned | 兼容试验、会话绑定、授权及故障恢复 |
| DEV-005 | NFR-003 | src/storage | DEV-003 | planned | 数据域、幂等回执、备份与恢复测试 |
| DEV-006 | FR-003, FR-006, NFR-001 | src/application | DEV-003, DEV-004, DEV-005, DEV-007 | planned | 用例、冲突控制、接受退回及故障注入测试 |
| DEV-007 | FR-005 | src/delivery | DEV-004 | planned | 原生事件、交付版本与证据校验 |
| DEV-008 | FR-007, NFR-004 | src/web | DEV-006 | planned | 任务界面及两条 M1 验收链路 |
| DEV-009 | FR-008, NFR-006 | src/usage | DEV-006 | planned | 用量归属、缺报、费用估算与对账 |
| DEV-010 | FR-009 | src/application | DEV-006 | planned | 索引及阶段交接 |
| DEV-011 | FR-010 | src/harness | DEV-008, DEV-009 | planned | 有限委派与冲突隔离验证 |
