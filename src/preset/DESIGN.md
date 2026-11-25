# 任务协作预设

归属 FR-001，入口为 [cordis.patch.yml](cordis.patch.yml)。在 Web 插入独立的 task-collaborator preset，保留宿主默认值，通过 persona 和原生工具组合承载任务判断与执行。首次提交前选择预设，运行时保留原生权限策略。

口径为工作领域与执行方式分开。小任务直接做，方向性返工高先形成可审样稿，时效信息先查证，可复用步骤按需读取技能。Prompt 只能影响建议。功能验收取真实模型的代表任务和用量，模拟模型只验证传输、工具可见性和隔离。

[reviewer.patch.yml](reviewer.patch.yml) 定义独立文本审阅预设，仅由同时加载 Host 隔离模块的完整 overlay 引入。
