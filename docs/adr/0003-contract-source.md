# 以 JSON Schema 作为公共类型事实来源

UI、宿主适配、测试和后续工具共享 contracts/v1 中的声明。以可机读契约替代多个模块手写 DTO，支撑跨模块检查和版本化，代价是运行时校验器及类型生成需跟着契约升级。

后继决策见 [ADR-0004](0004-versioned-api-contracts.md)。
