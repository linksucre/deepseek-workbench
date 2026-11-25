# 领域规则

术语见 [CONTEXT](CONTEXT.md)。Task 拥有交付要求和验收条件。一个 Task 可以有多次 Run，同一时刻最多一个活动 Run。每次 Submit 冻结 Artifact 与 Evidence 引用和其验收条件版本。Review 决策指向当前 Submit，退回允许产生下一次提交。

| 起点 | 动作 | 终点与条件 |
| --- | --- | --- |
| draft | ready | ready，目标、交付、至少一条验收条件齐备 |
| ready | start | active，仅在匹配的原生会话绑定持久化后进入 |
| ready 或 paused | start 结果不确定 | blocked，保留启动意图；确认归属后恢复或取消意图 |
| active | submit | review，保存不可变的提交版本 |
| review | accept | accepted，复核提交身份、权限与当前产物版本 |
| review | return | active，有退回理由并保留旧证据 |
| active | pause | paused，在原生停止可确认后进入 |
| paused | resume | active，复用可继续且权限有效的会话 |
| 非终态 | cancel | cancelled，已运行的动作需先确认停止 |

accepted 和 cancelled 为终态。修改已验收成果应创建关联任务。修改文件不会改变旧提交记录，但会产生版本漂移，需重新提交才可验收。外部会话被删除时保留历史引用并标出缺失。用户认可方案不等于验收最终成果。Task 与原生 Team 任务板分别表达业务交付和委派执行。
