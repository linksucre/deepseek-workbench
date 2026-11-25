# 测试计划

| 编号 | 验证 | 方法 |
| --- | --- | --- |
| TST-001 | 预设加载、交付工具、默认预设隔离 | 用固定版本真实 Web Host 与本地模拟模型截取请求；检查 HTTP 鉴权、系统指令及 read/write/edit、web_search/web_fetch、skill、present 是否逐一出现 |
| TST-002 | 状态、终态、授权 | [纯领域回归](tests/unit/task.test.mjs)；集成伪造任务、工作区越权、子会话越权、Cookie 缺失 |
| TST-003 | 并发、幂等、崩溃恢复 | [应用服务接入试验](tests/integration/application-smoke.mjs) 验证原生存储和文件层的状态流转、访问检查、幂等重放和漂移；同 revision 并发写，重放相同及不同摘要；模拟启动三阶段崩溃、超时、丢失响应、重启 |
| TST-004 | 产物及人工验收 | [交付模块回归](tests/unit/delivery.test.mjs) 验证选择范围、文件权限和重新计算版本；[原生展示联调](tests/integration/host-delivery-smoke.mjs) 验证已认证任务命令、跨源拒绝、任务跨重启、真实挂载失败后的启动重放和原 ID 复挂、实际工具调用、冷读、授权和版本变化；同一 Host 验证原生提交、退回重交、条件确认和终态复读；替换或移除文件、symlink 越界、旧提交回放、伪造工具证据 |
| TST-005 | 真实使用与流程选择 | 开发、设计、写作、材料各一真实授权任务；覆盖直接做、先审方向、先查证、复用、用户覆盖与中途调整 |
| TST-006 | 统计准确性 | [原生用量](tests/integration/usage-host-smoke.mjs) 验证失败结算、可得缓存、已绑定子会话及无凭据冷读；[生产命令](tests/integration/host-delivery-smoke.mjs) 与 [浏览器](tests/integration/browser-workbench.mjs) 验证授权、费用、软预算与缺报 |
| TST-007 | 迁移与发布 | [存储原生后端冒烟](tests/integration/storage-smoke.mjs) 验证备份、重开、并发 revision 与重放；另覆盖损坏记录、停用、版本兼容；区分试运行、发布验收和回滚 |
| TST-008 | 列表性能与界面 | [分页基准](tests/integration/list-performance.mjs) 写入 3000 条任务并重开原生后端，采样 50 次热读 50 条并记录 p95、环境和样本；[真实浏览器双链路](tests/integration/browser-workbench.mjs) 验证会话对话、材料漂移、退回及再次接受，覆盖 390px 小屏；键盘和长文本专项待补 |
| TST-009 | 工程规范 | 自动校验文档、唯一编号、追踪覆盖、任务依赖及契约引用，PR 检查敏感目录的文档变更；元模式与工具缺失均有负例回归 |
| TST-010 | 多 Agent 协作 | [原生 Host 审阅隔离](tests/integration/host-delivery-smoke.mjs) 验证默认须用户派发、无工具及父上下文继承、授权、并发限制、原生完成但尚未入账时重启恢复、显式回送及子会话用量。由 [浏览器验收](tests/integration/browser-workbench.mjs) 验证 UI 派发与回送 |
| TST-011 | 上下文索引 | 来源、日期、权限，过期资料提示和同一任务重启恢复 |
| TST-012 | M1 首条集成验收 | [评审场景](docs/design/M1-RECOVERY-AND-SUBMISSION.md)，使用真实 Host 和模拟模型，覆盖预留 ID、重启、挂载、用户覆盖、提交选择、漂移、退回与再次接受 |

本地 M0 门禁先运行 `npm ci`，再运行 `npm run check` 和 `npm run test:smoke -- /path/to/built/deepseek-harness`。CI 从固定提交构建上游，运行相同集成脚本。真实模型试跑属于 M1 验收，单独保存脱敏证据。失败应记范围、复现、预期及实际，避免把跳过写成通过。
