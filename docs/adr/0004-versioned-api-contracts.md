# 按 API 版本管理公共契约

DEV-002 继续以 JSON Schema 作为公共契约的唯一来源。原 v1 客户端与联调版的提交输入和部分响应字段不兼容，因此冻结 [v1 契约](../../contracts/v1/)，由 Host、Web、原生工具和测试使用 [v2 契约](../../contracts/v2/)。本决策继承 [ADR-0003](0003-contract-source.md) 的单一来源原则，批准依据见 [PR #11](https://github.com/linksucre/deepseek-workbench/pull/11#issuecomment-7180770004)。

联调版旧地址在迁移期间指向同一 v2 Host，共用校验、授权和幂等回执。原生工具继续使用 `workbench_submit` 及联调版的输入形状。原 v1 形状仅保留为契约基线。调用方核查、别名撤除条件和备份回退见 [部署说明](../DEPLOYMENT.md#从联调预览升级到-api-v2)。
