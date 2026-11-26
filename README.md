# DeepSeek Workbench

给个人工作者的 DeepSeek Harness 扩展。一个任务协作 Agent 根据目标和验收条件选做法，工作台关联会话、交付证据、验收与用量。

联调候选包含任务协作预设和本机 Web 工作台。工作台支持任务模板、组合执行方式、会话恢复、资料预览与阶段交接、交付版本与验收证据，以及用量估算和独立审阅。发布与验收状态见 [开发任务](TASKS.md) 和 [验收表](ACCEPTANCE.md)。

| 阶段 | 文档 |
| --- | --- |
| 1 项目边界与需求 | [SRS](SRS.md) · [SCOPE](SCOPE.md) · [DOMAIN](DOMAIN.md) · [术语](CONTEXT.md) |
| 2 系统设计 | [ARCHITECTURE](ARCHITECTURE.md) · [MODULES](MODULES.md) · [TECH_STACK](TECH_STACK.md) |
| 3 公共契约 | [API_SPEC](API_SPEC.md) · [DATA_MODEL](DATA_MODEL.md) · [DATABASE](DATABASE.md) · [SECURITY](SECURITY.md) |
| 4 模块设计 | [模块目录和设计索引](MODULES.md) |
| 5 开发协作 | [AGENTS](AGENTS.md) · [工程规范](docs/ENGINEERING.md) · [PROJECT_STRUCTURE](PROJECT_STRUCTURE.md) · [TASKS](TASKS.md) |
| 6 质量门禁 | [TEST_PLAN](TEST_PLAN.md) · [ACCEPTANCE](ACCEPTANCE.md) |
| 7 维护与部署 | [ADR 索引](docs/adr/README.md) · [CHANGELOG](CHANGELOG.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) |

在根目录运行 `npm ci` 安装门禁依赖，再运行 `npm run check`。预设集成测试需要一个已构建的 Harness 基线工作树，运行 `npm run test:smoke -- /path/to/built/deepseek-harness`。本地启动见部署文档。

本机使用从添加工作区和新建任务开始。执行前可修改 Agent 建议的做法。提交后在同一任务核对交付文件版本与验收证据，退回时可从原会话继续。需要续接任务时，展开「资料与阶段交接」查看来源及最近决定，正文仅在点选后读取。 [部署手册](docs/DEPLOYMENT.md)
