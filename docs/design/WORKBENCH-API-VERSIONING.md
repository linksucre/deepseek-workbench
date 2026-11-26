# 工作台 API 版本与兼容评审

DEV-002、NFR-005，涉及 FR-005、FR-006、FR-008、NFR-006。评审基线为 `main` 的 `e252c32` 和联调候选 `1b3d2c4`。接口规则见 [API 契约](../../API_SPEC.md)，验收沿用 [TST-002、TST-004、TST-006、TST-007、TST-009](../../TEST_PLAN.md)。

## 两版差异

在 Node 24.22.3 上，用候选 Host 同样的 Ajv 2020 和 Zod 格式校验，分别验证两份原始 schema。14 组输入和输出样例全部符合下表。

| 对象 | 样例 | 原 v1 | 候选 |
| --- | --- | --- | --- |
| `SubmitTask`、`AgentSubmit` | 提供 `artifactIds`、`evidenceRefs` | 通过 | 拒绝 |
| `SubmitTask`、`AgentSubmit` | `selection: latest-presentation` 或 `selection: files` 加 `paths` | 拒绝 | 通过 |
| `SubmitTask` | `files` 缺少 `paths`，或 `latest-presentation` 携带 `paths` | 拒绝 | 拒绝 |
| `DecideTask` | 旧请求省略 `confirmedCriteria` | 通过 | 通过 |
| `DecideTask` | 新请求带 `confirmedCriteria` | 拒绝 | 通过 |
| `TaskDetail` | `decisions` 仅含旧字段 | 通过 | 通过 |
| `TaskDetail` | `decisions` 带 `reviewEvidence`，即使值为空数组 | 拒绝 | 通过 |
| `UsageSummary` | 省略 `softBudget` | 通过 | 通过 |
| `UsageSummary` | 配置 `softBudget` 后返回对应字段 | 拒绝 | 通过 |

原有 16 个操作的索引项及共用错误定义一致。`reviewEvidence` 会影响 `task.create`、`task.updateBrief`、`task.get`、`task.choose`、`task.ready`、`task.start`、`task.reconcile`、`task.pause`、`task.resume`、`task.cancel`、`task.submit` 和 `task.decide` 的详情响应。`softBudget` 影响 `task.usage`。原契约的对象关闭了附加属性，旧客户端会拒绝含这些字段的响应。`task.decide` 通过 schema 仅说明旧请求形状有效。候选仍会核对当前提交、产物版本以及可信验收证据，缺少实际人工确认时按现有规则拒绝。

候选增加 `task.prompt`、`task.conversation`、`task.delegate`、`task.reviews`、`task.review.reconcile`、`task.review.forward`、`task.context.index` 和 `task.context.load`。新增操作的权限及行为由各所属工单评审。DEV-010 的资料设计稿暂写 v1，最终文档与所选 API 版本同步。

## 版本方案

建议冻结 `contracts/v1` 的原始定义，将候选公共形状放入 `contracts/v2`。同步独立 schema 标识、操作索引版本、客户端与 Host 校验、包内契约和 [API 说明](../../API_SPEC.md)。Web 和 Host 命令一起切换到 `/workbench/v2/command`。原生工具另有发现和历史调用路径，评审需确定新提交工具标识及旧调用的处理方式。候选的 `workbench_submit` 已被用于联调，切换时需核实历史会话、试用包与脚本的使用情况。工具输入继续从批准后的版本化契约注册和验证，任务及身份仍由 Host 从会话绑定推导。

`main` 的 M0 目前仅运行预设。维护者若确认没有需要继续服务的旧契约调用方，可批准首个工作台业务入口只部署 v2，并在兼容说明中记录从联调版端点及工具升级的方法。若存在依赖旧形状的调用方，先确认它们需要哪些操作，再批准并行 v1 入口或协商迁移期限。原请求没有需要人工勾选时的 `confirmedCriteria`，实际需要人工确认的调用必须迁移到支持这一动作的客户端。

若保留 v1 入口，使用 v1 schema 校验请求与响应，由同一个应用服务完成写入。旧产物 ID 只有在 Host 能唯一解析到当前授权 Run 的展示和版本时才可转换。无法证明归属、已漂移或有歧义的引用返回对应拒绝，不能替换成最新展示。`evidenceRefs` 只可指向经 Host 核验的现有证据，调用方提供的引用或文本本身不产生可信证据。v1 响应在传输层按原契约省略 `reviewEvidence` 和 `softBudget`，已存证据原样保留。

沿用任务、主体、逻辑操作和 `requestId` 的回执作用域。兼容入口对可证等价的输入返回同一回执，改了语义或无法证明等价的请求按既有冲突规则拒绝。原样重放应先在授权范围内核对回执，无需重新选取当前展示。调用方走不同 URL 或原生工具标识时，同一逻辑写入也只能推进一次 revision。联调版已有回执的兼容需要用真实 profile 复测，摘要升级方式由评审决定。

## 上线、回退与验收

API 版本和任务记录 `schemaVersion` 独立。切换前停写并备份 profile。保留已有任务、提交、人工证据和回执，先在副本验证升级、冷重放和可用的回退基线。若旧安装包无法读取新记录，用已验证的升级前备份恢复旧环境，同时保留升级后的 profile 供后续恢复。联调候选的 `v1` 命令路径已经使用新形状，不能当作原 v1 兼容入口。

1. 延续本次双向校验，锁定原 v1 形状，用严格解码器分别验证旧客户端和 v2。若批准 v1 适配，验证投影后的响应通过原校验器，且原记录仍保留新字段。
2. 在固定 Harness 验证 owner 入口的认证与同源限制、工作区边界、Agent 当前根会话绑定、过期提交版本及终态拒绝。核对按原生展示和按文件提交，覆盖歧义 ID、无权路径、漂移、模型自述、明确人工确认、用户退回后重交。
3. 覆盖同 ID 同输入跨重启重放，及更换输入后拒绝。若双版本并存，还需验证同 ID 跨版本并发只写入一次、各自收到符合版本的响应，以及权限撤销后无法读取已有回执。
4. 用已有任务及联调回执验证新包升级、停用再启用和备份回退。用真 Host 验证 Web 只访问选定端点、已绑定会话发现对应工具，以及资料、审阅和用量功能各自通过验收门禁。
5. 评审时记录旧客户端及旧工具使用情况，明确 v1 是否部署、支持范围和迁移期限。合入前要求仓库差异门禁、可拉取固定 Harness 的远端集成及适用验收通过。
