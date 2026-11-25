# 开发任务

工单分支使用 `dev/<DEV-ID>-<slug>`。开始后在工单或本表记录负责人及分支，再修改代码。同一需求只能有一个主实施工单。状态为 planned、active、review、done；done 需附验收证据。下表拆分模块开发及依赖。

| 工单 | 需求 | 主责目录 | 依赖 | 状态 | 完成产物 |
| --- | --- | --- | --- | --- | --- |
| DEV-001 | FR-001 | src/preset | — | done | 预设及模拟模型集成通过，逐项断言必需工具 |
| DEV-002 | NFR-005 | scripts、contracts、docs、.github | — | done | 需求追踪、元模式验证、负例回归与 PR 流程 |
| DEV-003 | FR-002 | src/domain | DEV-002 | done | 纯状态机、领域测试与契约校验 |
| DEV-004 | FR-004, NFR-002 | src/harness | DEV-003 | active | 兼容试验、会话绑定、授权及故障恢复 |
| DEV-005 | NFR-003 | src/storage | DEV-003 | review | 数据域、幂等回执、备份与恢复测试 |
| DEV-006 | FR-003, FR-006, NFR-001 | src/application | DEV-003, DEV-004, DEV-005, DEV-007 | active | 用例、冲突控制、接受退回及故障注入测试 |
| DEV-007 | FR-005 | src/delivery | DEV-004 | active | 原生事件、交付版本与证据校验 |
| DEV-008 | FR-007, NFR-004 | src/web | DEV-012 | planned | 任务界面及两条 M1 验收链路 |
| DEV-009 | FR-008, NFR-006 | src/usage | DEV-006 | planned | 用量归属、缺报、费用估算与对账 |
| DEV-010 | FR-009 | src/application | DEV-006 | planned | 索引及阶段交接 |
| DEV-011 | FR-010 | src/harness | DEV-008, DEV-009 | planned | 有限委派与冲突隔离验证 |
| DEV-012 | — | tests/integration | DEV-006 | active | M1 跨模块联调，先完成恢复、原生展示到提交、漂移退回及重交接受 |

## 当前领取

本地协作登记写在主工作目录的这份表。各 Agent 在自己的工作树开发，并以提交编号回填验收；其他工作树保留各自的文件和改动。

| 工单 | 负责人 | 分支 | 改动范围 |
| --- | --- | --- | --- |
| `DEV-004` | 另一 Agent（根据已存在的工作树登记） | `dev/DEV-004-harness-recovery` | Harness 会话恢复及对应测试 |
| `DEV-005` | Codex | `dev/DEV-005-task-storage` | 存储适配、存储测试与对应文档 |
| `DEV-007` | Codex | `dev/DEV-007-delivery` | 展示选择、文件版本核验和证据转换；宿主绑定依赖 DEV-004 |
| `DEV-006` | Codex | `dev/DEV-006-application` | 应用服务、存储与交付接入；DEV-004 继续持有原生恢复 |
| `DEV-012` | Codex | `dev/DEV-012-host-delivery` | 联调切片：先接真实 Host 展示事件，后续继续完整验收 |

DEV-005 提交 `d139fe0`，原生 JSON 后端已验证启动意图持久化、revision 竞争、幂等重放、关闭重开与备份恢复。工作台 Host 集成和迁移仍待验证。DEV-004 可通过 `src/storage/task-repository.mjs` 的 commit 在单键更新中保存或清除 pendingIntent；跨模块接口由 DEV-006 接入。

DEV-004 提交 `44cf655`，已将真实 Web Host 的挂载故障和冷启动复挂载纳入冒烟测试。原生挂载错误返回原会话与工作区 ID；复挂载保持原 ID，重复请求只留一个成员关系，再次重启仍能读取。工作台如何持久化和核验受信 Host 回执仍待评审；工作台恢复实现等待 DEV-003 合并及方案确认。

DEV-004 提交 `fa3103f` 补充原生停止、继续和请求重放验证。`session/cancel` 受理后，通过 `session/wait` 确认空闲；队列内容保留，只有新输入会唤醒会话。会话重启后以同一请求 ID 重放不会再次调用模型。此验证通过真实 Host 冒烟、仓库门禁及 61 项上游取消与队列测试。

DEV-007 提交 `afdcc88`，已实现阶段内展示选择、产物来源与 SHA-256 版本、重验和可信检查证据转换。仓库门禁及 10 项测试通过。保持 active，剩余工作为接入 DEV-004 的可信会话事件和授权，并验证原生 present 到提交的实际链路。

DEV-006 提交 `d8076be`，在应用联调分支接入 DEV-005 与 DEV-007。原生 JSON 后端和本地文件试验已覆盖意图跨重开、有效根会话核验输入、用户改选、模型角色隔离、幂等提交、文件漂移、退回与接受，10 项回归和仓库门禁通过。保持 active，等待 DEV-004 的真实 Host 生命周期接入，再补阶段游标、Remote 和 DEV-012 实际联调。跨模块接入可以参考该分支，原工单分支继续独立开发。
