# 代码目录

```text
src/          模块目录，各目录内的 DESIGN.md 标明边界
contracts/v1/ 冻结的原公共契约
contracts/v2/ 公共操作索引与 JSON Schema
tests/        集成测试；新增 unit/、fixtures/、e2e/ 按工单落地
scripts/      本地与 CI 公用门禁
docs/         开发规范、部署、ADR 和后续验证记录
.github/      PR 模板和 CI
```

根目录保存需求、架构、公共契约说明、任务、测试和验收索引。新增模块先在 [MODULES](MODULES.md) 登记并建对应设计。生成文件后续集中到构建输出，除发布契约外由 CI 重建。
