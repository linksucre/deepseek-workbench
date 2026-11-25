# 测试计划

| 编号 | 验证 | 方法 |
| --- | --- | --- |
| TST-001 | 预设加载、交付工具、默认预设隔离 | 用固定版本真实 Web Host 与本地模拟模型截取请求；检查 HTTP 鉴权、系统指令及 read/write/edit、web_search/web_fetch、skill、present 是否逐一出现 |
| TST-002 | 状态、终态、授权 | [纯领域回归](tests/unit/task.test.mjs)；[应用授权](tests/integration/application-smoke.mjs) 校验会话归属和角色；[真实 Host](tests/integration/host-delivery-smoke.mjs) 验证无 Cookie、跨源、未知任务或工作区、工作区游标串用，以及草稿和终态中的非法命令 |
| TST-003 | 并发、幂等、崩溃恢复 | [应用服务接入试验](tests/integration/application-smoke.mjs) 验证原生存储和文件层的状态流转、访问检查、幂等重放和漂移；[真实 Host](tests/integration/host-delivery-smoke.mjs) 并发验证同请求 ID 的启动与提交、启动核对跨操作复用拒绝和原请求冷读、同 revision 的两次接受、不同摘要拒绝和冷启动重放。覆盖启动意图落盘后强制退出、原生挂载失败、响应丢失和创建超时后的迟到回执。[Chromium](tests/integration/browser-workbench.mjs) 在真实 Host 写入接受决定后截断 HTTP 响应，验证用户重试复用请求 ID，任务、提交、决定及 revision 在重试和重启后保持一致 |
| TST-004 | 产物及人工验收 | [交付模块回归](tests/unit/delivery.test.mjs) 验证选择范围、文件权限和重新计算版本；[原生展示联调](tests/integration/host-delivery-smoke.mjs) 验证已认证任务命令、跨源拒绝、任务跨重启、真实挂载失败后的启动重放和原 ID 复挂、实际工具调用、冷读、授权和版本变化；同一 Host 验证原生提交、owner 从两次原生展示中按文件选择较早一份并保存其来源和哈希、并发幂等及重启后改选重放拒绝、退回重交、条件确认和终态复读；拒绝内容漂移、文件移除、符号链接替换、旧提交回放和原生工具伪造任务 ID 或机器证据。文件范围越界及固定检查版本变化由交付回归覆盖；[浏览器验收](tests/integration/browser-workbench.mjs) 核对 JSON 失败、重交、通过后逐项确认及证据重开 |
| TST-005 | 真实使用与流程选择 | 按 [真实任务试跑手册](docs/design/M1-REAL-TASK-ACCEPTANCE.md) 执行开发、设计、写作、材料各一真实授权任务；覆盖直接做、先审方向、先查证、复用、用户覆盖与中途调整。本地[应用回归](tests/integration/application-smoke.mjs) 验证四种建议与用户改选的持久历史，[Chromium](tests/integration/browser-workbench.mjs) 用模拟模型验证原生工具建议、用户组合改选、复制到任务说明及重启复读 |
| TST-006 | 统计准确性 | [原生用量](tests/integration/usage-host-smoke.mjs) 验证失败结算、可得缓存、已绑定子会话及无凭据冷读；[生产命令](tests/integration/host-delivery-smoke.mjs) 与 [浏览器](tests/integration/browser-workbench.mjs) 验证授权、费用、软预算与缺报 |
| TST-007 | 迁移与发布 | [存储原生后端冒烟](tests/integration/storage-smoke.mjs) 验证 V1 兼容、备份、不可读记录拒绝打开、打开后损坏的记录拒绝更新并保留源数据、干净备份重试、并发 revision 和跨重启回执重放；[Host 交付冒烟](tests/integration/host-delivery-smoke.mjs) 验证同版本停用与恢复 |
| TST-008 | 列表性能与界面 | [分页基准](tests/integration/list-performance.mjs) 写入 3000 条任务并重开原生后端，每组 75 条使用同一更新时间。核对全部 60 页的任务 ID 顺序和最终游标，再采样 50 次热读首页并记录 p95、环境和样本；[真实浏览器双链路](tests/integration/browser-workbench.mjs) 验证四种任务模板、草稿冷读、待核对操作、会话对话、材料漂移、退回及再次接受，覆盖 390px 小屏、键盘、会话跳转、8192 字符目标及真实用户确认与合成证据的分类展示。验证通过按钮暂停、恢复原根会话、取消后刷新及重启复读且未调用模型。延迟列表响应后连续切换工作区，验证旧任务立即清空，最终列表和详情与最后一次选择一致。对 53 条真实 Host 任务验证首屏 50 条、切换时重置游标、键盘追加最后 3 条及末页隐藏按钮 |
| TST-009 | 工程规范 | 自动校验文档、唯一编号、追踪覆盖、任务依赖及契约引用，PR 检查敏感目录的文档变更；元模式与工具缺失均有负例回归 |
| TST-010 | 多 Agent 协作 | [原生 Host 审阅隔离](tests/integration/host-delivery-smoke.mjs) 验证默认须用户派发、无工具及父上下文继承、授权、问题与材料的 24 KiB UTF-8 边界和原生请求携带的 `max_tokens=1024`、并发限制、原生完成但尚未入账时重启恢复、显式回送（含审阅 ID 和核查提示）及子会话用量（含重启后缺报）。[审阅适配层回归](tests/unit/bounded-review.test.mjs) 用受控原生接口验证超时只触发一次清理、清理完成前保留运行插槽、迟到结果标为未完成，以及后续派发正常。由 [浏览器验收](tests/integration/browser-workbench.mjs) 验证 UI 派发与回送；[worktree 试验](tests/integration/worktree-isolation-smoke.mjs) 验证本地写隔离、共享 Git 元数据拒绝和冲突保留 |
| TST-011 | 上下文索引 | [上下文冒烟](tests/integration/context-smoke.mjs) 验证来源、日期、过期提示、UTF-8 BOM 和换行原样返回及重启，覆盖读取中移除工作区、解除会话绑定与释放观测租约；[Host](tests/integration/host-delivery-smoke.mjs) 验证同源认证、任务范围、归档用户与助手消息、原生提交版本及不调用模型；[浏览器](tests/integration/browser-workbench.mjs) 验证录入、保留原文件名及日期、网址校验、按需读取、纯文本预览，以及退回改选后的交接方式名称和资料预览 |
| TST-012 | M1 首条集成验收 | [评审场景](docs/design/M1-RECOVERY-AND-SUBMISSION.md)，使用真实 Host 和模拟模型，覆盖预留 ID、重启、挂载、用户覆盖、提交选择、漂移、退回与再次接受。[浏览器](tests/integration/browser-workbench.mjs) 验证故障后拒绝错误会话 ID、重启复挂原会话及结束意图后显式启动 |

本地 M0 门禁先运行 `npm ci`，再运行 `npm run check` 和 `npm run test:smoke -- /path/to/built/deepseek-harness`。CI 从固定提交构建上游，运行相同集成脚本。真实模型试跑属于 M1 验收，单独保存脱敏证据。失败应记范围、复现、预期及实际，避免把跳过写成通过。

[Harness integration](.github/workflows/ci.yml) 在 macOS 上运行上下文冒烟、原生 worktree 写入隔离试验和分页基准。worktree 试验使用临时 Git 仓库，验证两条分支的写入隔离和冲突后的结果保留。分页输出包括机器、Node 版本、样本数及 p95。浏览器使用独立安装的本地归档。

DEV-011 修订回归使用 `node tests/integration/host-delivery-smoke.mjs /path/to/built/deepseek-harness --review-recovery-regressions`，也可用下列参数逐一运行：

- `--review-recovery-regressions=cold-root` 先观察原生根会话确实未加载，再核对拒绝无副作用、激活后仍可派发两次。
- `--review-recovery-regressions=reconcile-receipt` 核对请求摘要、重启重放及无新增写入或模型请求。
- `--review-recovery-regressions=forward-scope` 等普通消息出现在原生会话历史后回送，并核对两条消息各自的原生请求 ID 与数量。

三项审阅恢复专项均纳入 Harness integration CI。原生测试注入回送已受理后的响应丢失，并用独立 profile 重启核对真实旧事件。Chromium 验证浏览器丢失响应后重新加载并复用原输入。

Chromium 在真实 Host 注入入队前明确拒绝，验证页面在原处显示失败并读取新 revision，用户再次点击可用新请求 ID 完成回送。第二次请求由原生受理后截断响应，再重新加载页面，验证核对时仍使用第二次请求的原输入。

入队前拒绝回归在 CI 使用独立参数 `--review-recovery-regressions=forward-pre-admission`。测试在真实 Host 的原生提示入口、入队调用前注入带 `session/not-found` 的结构化拒绝。核对原始原生请求 ID 无消息、无模型调用，重启后重放同一公开请求取得相同失败且 revision 保持稳定，修改输入重放返回 `INVALID`，随后能暂停、恢复并用新请求 ID 回送一次。

TST-010 双版本 profile 验证使用 `node tests/integration/host-delivery-smoke.mjs /path/to/built/deepseek-harness --review-profile-upgrade-from=/path/to/legacy-workbench`。两个已安装依赖的 Workbench 检出应固定同一个 Harness 版本，旧检出须支持旧版审阅回送，例如 `8fde87b`。脚本用模拟模型和临时 profile 让旧插件实际写入回送及普通消息，再以新插件升级同一 profile。核对旧请求重放、冲突识别和新请求的单次受理，并用停写备份的副本启动旧插件，确认回退后的记录与回执，以及升级副本仍能冷重放新请求。该命令单独运行。
