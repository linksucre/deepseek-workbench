# 模块边界与责任

每个开发工单以单模块为写入范围，公共契约及跨模块修改先由维护者合并设计。下表的依赖指业务代码方向，测试和宿主组合入口负责装配。

| 模块 | 目录与详细设计 | 职责 | 可以依赖 |
| --- | --- | --- | --- |
| preset | [src/preset](src/preset/DESIGN.md) | 预设声明及系统指令 | Harness 公共插件 |
| domain | [src/domain](src/domain/DESIGN.md) | 领域对象、状态机、约束 | contracts |
| application | [src/application](src/application/DESIGN.md) | 用例、授权顺序、业务端口 | domain、contracts |
| harness | [src/harness](src/harness/DESIGN.md) | 会话、工作区和工具入口适配 | application 端口、contracts、Harness |
| storage | [src/storage](src/storage/DESIGN.md) | 聚合更新、恢复、迁移 | application 端口、domain、contracts、Harness |
| delivery | [src/delivery](src/delivery/DESIGN.md) | 交付版本和证据采集 | application 端口、contracts、Harness |
| usage | [src/usage](src/usage/DESIGN.md) | 用量投影、完整性、估算 | application 端口、contracts、Harness |
| web | [src/web](src/web/DESIGN.md) | 用户任务列表、详情、验收视图 | contracts、宿主客户端公共接口 |
| governance | [scripts/check.mjs](scripts/check.mjs) | 检查契约引用与需求覆盖、同步 | 文档、contracts |

应用层面向端口，由宿主组合提供适配器。领域模块不接受网络请求、时钟或文件系统服务。模块自己的 DTO 只用于内部计算，公开对象引用公共契约。跨模块实施前按 [工程规范](docs/ENGINEERING.md) 收敛接口评审。
