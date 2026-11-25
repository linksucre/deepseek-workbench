# 存储适配

归属 NFR-003。以单 Task key 更新聚合、revision 和幂等回执。开启单写宿主前验证 storageDomain 的原子更新语义与重启快照。读索引从域数据重建。无法解码的记录报告完整性问题并停止受影响写入。

恢复时扫描未决意图与有效绑定，待核对动作交回应用服务。迁移程序需接受旧样本和中断恢复测试，备份与回滚步骤见 [DATABASE](../../DATABASE.md)。

[task-repository.mjs](task-repository.mjs) 实现适配器。宿主注入原生域构造函数、Zod 和从公共契约编译的 TaskDetail 校验器。域名为 `workbench_tasks`，符合上游只允许小写字母、数字和下划线的命名约束。物理布局为每条记录一个单元，schemaVersion 为 1。

单宿主创建一个仓库实例。create 检查已分配 Task ID 与创建回执，commit 在原生 update 槽位检查 revision，将聚合、单一待处理意图及幂等回执原子提交。相同请求回传当时的结果，不重跑 transform。transform 必须同步且不执行外部副作用。回执保留完整结果以支持重放，压缩策略在部署容量评估后排期。授权、请求摘要和启动意图归属由应用层确认。

exportSnapshot 通过同一队列生成一致的脱敏前业务快照。维护者须按授权选择导出内容；恢复当前使用原生后端的停写备份。当前只有 V1 格式，遇到未知版本拒绝读取，未来迁移需要新增版本及旧数据样例。

验证命令为 `node tests/integration/storage-smoke.mjs /path/to/built-deepseek-harness`。测试在固定基线使用原生 DomainFacility 和 JSON 后端：并发 revision、请求重放、意图归属检查、关闭重开与物理备份打开。业务 API 和实际会话绑定留给后续联调。
