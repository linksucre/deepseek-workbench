# 本地部署与回滚

要求 Node 24.22.3、基线指定提交的 Harness 和它要求的 pnpm。上游目录与本仓库分别管理。

1. 根据 [harness-baseline.json](../harness-baseline.json) 准备上游干净 checkout，执行 `corepack pnpm install --frozen-lockfile` 和 `corepack pnpm run build`。
2. 在本仓库执行 `npm ci` 与 `npm run check`，再执行 `npm run test:smoke -- /path/to/built/deepseek-harness`。
3. 从工作台仓库生成启用完整本地 Host 扩展的 overlay。输出路径应不存在，生成器会验证上游提交，并将本地入口及依赖位置写入该文件。

```sh
node scripts/source-overlay.mjs /path/to/built/deepseek-harness /path/to/new-workbench-overlay.yml
```

4. 在构建后的 Harness checkout 启动独立 profile。

```sh
DSH_HOME="$HOME/Library/Application Support/DeepSeek Harness Workbench" \
  corepack pnpm dsh --profile web --patch /path/to/new-workbench-overlay.yml \
  --host 127.0.0.1 --port 3081
```

使用 Harness 打印的本地链接登录，然后访问同一地址的 `/workbench`。工作台可注册工作区、建任务、启动会话并验收提交。工作台可直接打开绑定会话的对话视图及发送消息。需要 Harness 原生审批等交互时，可用页面里的会话 ID 在 Harness 中定位。只需要预设时，可以改用 `src/preset/cordis.patch.yml`。真实模型由部署者按 Harness 的方式在独立数据目录提供凭据。启动日志包含临时登录链接，保存在本机受限文件中。备份业务数据时仅导出授权记录。

回滚前停止当前服务，备份 Harness 独立数据目录。使用去掉补丁的同版本 Web profile 验证标准预设；需要继续打开使用任务协作预设的现有会话时，使用原版本补丁重启。M1 开始引入任务存储后，按 [数据库文档](../DATABASE.md) 验证备份恢复再启用旧版本。

## 验收与恢复

本地试运行可用模拟模型。候选发布按 [验收标准](../ACCEPTANCE.md) 逐项验证，并按 [测试计划](../TEST_PLAN.md) 保存真实授权模型试跑和安装复核证据。

TST-007 在固定上游版本，用已停止的独立 profile 验证同版本停用和恢复。停用副本去掉 overlay 后，标准 Web Host 仍能读取原生会话，工作台命令停止提供服务。恢复时复制备份到新目录，使用原 overlay 核对任务、操作回执和绑定的原生会话。上游版本不同的回滚需另行验证。

当前私有 manifest 供本地开发，发布形态需通过上游安装能力工单确认。

本地入口以已构建源码为安装载体。当前版本通过源码 overlay 部署完整 Host，预设 bundle 继续作为单独入口。已用本地归档安装和浏览器双链路验证源代码资产与运行依赖。

可以用 `npm pack` 构建本地归档，安装到独立目录，再执行已安装的生成器。归档安装依然需要同版本、已构建的上游 checkout。

```sh
npm pack --pack-destination /path/to/artifacts
npm install --prefix /path/to/local-install /path/to/artifacts/deepseek-workbench-0.1.0.tgz
node /path/to/local-install/node_modules/deepseek-workbench/scripts/source-overlay.mjs   /path/to/built/deepseek-harness /path/to/new-workbench-overlay.yml
```

## 配置用量估算及预算提醒

可把本地 JSON 路径作为生成 overlay 的第三个参数。省略时仍可看计数和覆盖，估算金额为空。以下数字仅演示字段格式，部署时填写实际适用费率。费率单位为每百万 token，按提供方、模型和 UTC 生效日期匹配。

```json
{
  "rates": [{
    "provider": "deepseek-official",
    "model": "deepseek-flash",
    "currency": "CNY",
    "rateDate": "2025-01-01",
    "perMillion": { "uncachedInput": "1", "cacheRead": "0.2", "cacheWrite": "1", "output": "2" }
  }],
  "softBudget": { "currency": "CNY", "decimalAmount": "3.00" }
}
```

修改本地费率后重启整个工作台 profile。软预算适用于该 profile 的每个任务，只提醒，不停止模型。配置中无需填写凭据。

DEV-005 评审分支使用本机隔离的 Harness 补丁，按 [任务记录保护评审](design/TASK-RECORD-PRESERVATION.md) 验证。工作台遇到损坏记录时拒绝挂载，标准 Harness 会话仍可用。保留故障目录，从已核对备份创建独立 profile 并复验后恢复写入。
