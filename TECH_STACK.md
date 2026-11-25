# 技术选型

| 层 | 选型 |
| --- | --- |
| 基线 | Node 24.22.3、DeepSeek Harness 0.2.3-alpha.2、固定上游提交，见 [基线](harness-baseline.json) |
| 插件加载 | Cordis bundle + profile patch，托管于 Harness Web |
| 领域与适配 | 生产类型计划使用 TypeScript ESM。DEV-003 的纯领域模块先使用无构建步骤的 ESM JavaScript。首个编译实现工单引入锁文件和构建配置，类型与校验器来自契约 |
| 公共契约 | JSON Schema 2020-12 + 操作索引，统一 ID、字段、错误和成功输出 |
| 存储 | Harness storage domain，按 Task 聚合，单宿主写入。物理后端由部署配置可用的原生后端决定 |
| UI | Harness 的 Web 扩展入口与现有组件模式。先验证可用槽位及打包约束 |
| 测试 | Node 原生断言做当前集成测试；领域测试升级时延用 Node test runner 与版本化凭据隔离 fixture |
| CI | GitHub Actions，文档契约门禁及固定版本真实 Web Host 模拟模型回归 |

引入运行依赖、调整宿主版本、改变持久化模型或公开接口需要架构变更审阅。原型无独立运行时依赖。仓库门禁使用锁定的 Ajv 8 开发依赖及内置的 JSON Schema 2020-12 元模式。

DEV-005 评审分支的基线暂时固定在本地 Harness 存储补丁。发布基线在上游评审和 CI 验证后确定。
