# 测试计划

| 编号 | 验证 | 方法 |
| --- | --- | --- |
| TST-001 | 预设加载、交付工具、默认预设隔离 | 用固定版本真实 Web Host 与本地模拟模型截取请求；检查 HTTP 鉴权、系统指令及 read/write/edit、web_search/web_fetch、skill、present 是否逐一出现 |
| TST-002 | 状态、终态、授权 | [纯领域回归](tests/unit/task.test.mjs)；[应用授权](tests/integration/application-smoke.mjs) 校验会话归属和角色；[真实 Host](tests/integration/host-delivery-smoke.mjs) 验证无 Cookie、跨源、未知任务或工作区、工作区游标串用，以及草稿和终态中的非法命令 |
| TST-003 | 并发、幂等、崩溃恢复 | [应用服务接入试验](tests/integration/application-smoke.mjs) 验证原生存储和文件层的状态流转、访问检查、幂等重放和漂移；[真实 Host](tests/integration/host-delivery-smoke.mjs) 并发验证同请求 ID 的启动与提交、同 revision 的两次接受、不同摘要拒绝和冷启动重放。覆盖启动意图落盘后强制退出、原生挂载失败、响应丢失和创建超时后的迟到回执 |
| TST-004 | 产物及人工验收 | [交付模块回归](tests/unit/delivery.test.mjs) 验证选择范围、文件权限和重新计算版本；[原生展示联调](tests/integration/host-delivery-smoke.mjs) 验证已认证任务命令、跨源拒绝、任务跨重启、真实挂载失败后的启动重放和原 ID 复挂、实际工具调用、冷读、授权和版本变化；同一 Host 验证原生提交、退回重交、条件确认和终态复读；拒绝内容漂移、文件移除、符号链接替换、旧提交回放和原生工具伪造任务 ID 或机器证据。文件范围越界及固定检查版本变化由交付回归覆盖；[浏览器验收](tests/integration/browser-workbench.mjs) 核对 JSON 失败、重交、通过后逐项确认及证据重开 |
| TST-005 | 真实使用与流程选择 | 开发、设计、写作、材料各一真实授权任务；覆盖直接做、先审方向、先查证、复用、用户覆盖与中途调整 |
| TST-006 | 统计准确性 | [原生用量](tests/integration/usage-host-smoke.mjs) 验证失败结算、可得缓存、已绑定子会话及无凭据冷读；[生产命令](tests/integration/host-delivery-smoke.mjs) 与 [浏览器](tests/integration/browser-workbench.mjs) 验证授权、费用、软预算与缺报 |
| TST-007 | 迁移与发布 | [存储原生后端冒烟](tests/integration/storage-smoke.mjs) 验证 V1 兼容、备份、损坏记录及其原始字节保留、重放拒绝、重开、并发 revision 和回执重放；[Host 交付冒烟](tests/integration/host-delivery-smoke.mjs) 验证同版本停用与恢复 |
| TST-008 | 列表性能与界面 | [分页基准](tests/integration/list-performance.mjs) 写入 3000 条任务并重开原生后端，采样 50 次热读 50 条并记录 p95、环境和样本；[真实浏览器双链路](tests/integration/browser-workbench.mjs) 验证会话对话、材料漂移、退回及再次接受，覆盖 390px 小屏、键盘、会话跳转、8192 字符目标及真实用户确认与合成证据的分类展示 |
| TST-009 | 工程规范 | 自动校验文档、唯一编号、追踪覆盖、任务依赖及契约引用，PR 检查敏感目录的文档变更；元模式与工具缺失均有负例回归 |
| TST-010 | 多 Agent 协作 | [原生 Host 审阅隔离](tests/integration/host-delivery-smoke.mjs) 验证默认须用户派发、无工具及父上下文继承、授权、并发限制、原生完成但尚未入账时重启恢复、显式回送及子会话用量。由 [浏览器验收](tests/integration/browser-workbench.mjs) 验证 UI 派发与回送；[worktree 试验](tests/integration/worktree-isolation-smoke.mjs) 验证本地写隔离、共享 Git 元数据拒绝和冲突保留 |
| TST-011 | 上下文索引 | [上下文冒烟](tests/integration/context-smoke.mjs) 验证来源、日期、权限、过期提示和重启恢复；Host 测试验证原生提交事件，工作台公共读取入口待验 |
| TST-012 | M1 首条集成验收 | [评审场景](docs/design/M1-RECOVERY-AND-SUBMISSION.md)，使用真实 Host 和模拟模型，覆盖预留 ID、重启、挂载、用户覆盖、提交选择、漂移、退回与再次接受 |

本地 M0 门禁先运行 `npm ci`，再运行 `npm run check` 和 `npm run test:smoke -- /path/to/built/deepseek-harness`。CI 从固定提交构建上游，运行相同集成脚本。真实模型试跑属于 M1 验收，单独保存脱敏证据。失败应记范围、复现、预期及实际，避免把跳过写成通过。

[Harness integration](.github/workflows/ci.yml) 同时运行上下文冒烟和分页基准。分页输出包括机器、Node 版本、样本数及 p95。浏览器使用独立安装的本地归档。
