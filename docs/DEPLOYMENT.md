# 本地部署与回滚

要求 Node 24.22.3、基线指定提交的 Harness 和它要求的 pnpm。上游目录与本仓库分别管理。

1. 根据 [harness-baseline.json](../harness-baseline.json) 检出公开的 Harness `upstreamCommit`。从 Workbench 仓库执行 `node scripts/materialize-harness.mjs /path/to/harness-checkout`，再在还原后的 Harness 目录执行 `corepack pnpm install --frozen-lockfile` 和 `corepack pnpm run build`。脚本验证公开基线、[增量包](../vendor/harness/storage-records.bundle) 的 SHA-256 和目标 Git 提交。已还原的目录可直接构建。
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

### 备份和恢复独立 profile

停止正在写入该 profile 的 Harness Host。记录 Workbench、Harness 和 overlay 版本。以下命令适用于任务域和会话都位于独立 profile 的本机 JSON 部署。部署若使用外部存储目录或后端，按其备份方式取得同一时点的副本，恢复配置也指向副本。将示例路径替换为使用中的 profile 和已存在的备份父目录。

```sh
(
  umask 077
  profile_dir=$(cd '/path/to/stopped-profile' && pwd -P) &&
  backup_parent='/path/to/local-backups' &&
  backup_dir=$(mktemp -d "$backup_parent/workbench-backup.XXXXXXXX") &&
  cp -pRP "$profile_dir" "$backup_dir/profile" &&
  printf '%s\n' "$backup_dir/profile"
)
```

恢复时将备份的 `profile` 作为上述输入，将恢复位置作为父目录。把输出的新副本设为 `DSH_HOME`，用记录的 Harness 版本和 overlay 在本机另起进程。核对任务数、关键任务的 revision、启动意图、提交与验收历史、原生会话绑定以及已知请求的回执，再恢复正常写入。若遇到不可读记录，保留故障目录，并从已验证的较早备份另建副本。停用验证使用独立副本和同版本的标准 Web profile。

完整 profile 可能包含用户工作内容和宿主凭据，应保留在授权维护者可访问的本机备份目录。业务快照的范围见 [数据库说明](../DATABASE.md#备份与业务导出)。

当前私有 manifest 供本地开发，发布形态需通过上游安装能力工单确认。

本地入口以已构建源码为安装载体。当前版本通过源码 overlay 部署完整 Host，预设 bundle 继续作为单独入口。已用本地归档安装和浏览器双链路验证源代码资产与运行依赖。

可以用 `npm pack` 构建本地归档，安装到独立目录，再执行已安装的生成器。归档安装依然需要同版本、已构建的上游 checkout。

```sh
npm pack --pack-destination /path/to/artifacts
npm install --prefix /path/to/local-install /path/to/artifacts/deepseek-workbench-0.1.0.tgz
node /path/to/local-install/node_modules/deepseek-workbench/scripts/source-overlay.mjs   /path/to/built/deepseek-harness /path/to/new-workbench-overlay.yml
```

### 从本地评审包复验

候选 `5d63e78` 的评审包包含 Workbench Git bundle、独立 npm 安装归档、Harness 保护补丁的增量 bundle，以及 `SHA256SUMS`。评审者先在交接目录运行 `shasum -a 256 -c SHA256SUMS`。从 Workbench bundle 还原代码、测试和验收文档，不需要已有 Workbench 仓库。将评审检出建在用户目录下的普通工作目录。系统共享临时目录中的 worktree 隔离在当前 macOS Harness 基线上未通过。

```sh
review_dir='/absolute/path/to/handoff'
git init --initial-branch=review-initial workbench-review
git -C workbench-review bundle verify "$review_dir/workbench-5d63e78.bundle"
git -C workbench-review fetch --no-tags "$review_dir/workbench-5d63e78.bundle" \
  refs/heads/main:refs/heads/main \
  refs/heads/dev/DEV-002-receipts-release-verification:refs/heads/review/workbench
git -C workbench-review checkout --detach refs/heads/review/workbench
test "$(git -C workbench-review rev-parse HEAD)" = 5d63e784e7e5a4ffe38ea12e10ef024a11d3c86c
```

在含 `4b399c39a6d1479cd84ca591b4d7c88e24d38a96` 的独立 Harness 检出中导入 `protected-harness.bundle`。

```sh
git bundle verify "$review_dir/protected-harness.bundle"
git fetch --no-tags "$review_dir/protected-harness.bundle" \
  refs/heads/workbench/protect-task-records:refs/heads/review/harness-protection
git checkout --detach refs/heads/review/harness-protection
test "$(git rev-parse HEAD)" = 5bff262ae7f431f6a75cc1d4d7f52527d6e55727
corepack pnpm install --frozen-lockfile
corepack pnpm run build
```

原生构建需使用含 `node_api.h` 的 Node 24.22.3 与本机编译器。已有锁定依赖缓存时，安装命令可加 `--offline`。按前述安装步骤使用 `workbench-5d63e78.tgz`，从还原的 Workbench 检出运行 [测试计划](../TEST_PLAN.md) 中的命令。双版本升级与回退所需的旧 Workbench `8fde87b` 已在该 bundle 的历史中，可用独立 worktree 检出。评审包的发布条件见 [验收表](../ACCEPTANCE.md)。

验证排他创建修复时，使用包含同一公开基础提交 `4b399c39a6d1479cd84ca591b4d7c88e24d38a96` 的独立 Harness 检出。从评审目录校验 `harness-f17e00c4ea.bundle` 的 `SHA256SUMS`，运行 `git bundle verify`，再从 bundle 拉取 `refs/heads/workbench/DEV-005-exclusive-record-create`。检出并核对完整提交 `f17e00c4ea12f5b334071ea8feac58bbd31953aa` 后构建。仅在测试副本中临时更新 Workbench 的固定提交以运行 TST-007 和 TST-010。正式 CI 使用维护者批准且可检出的远端来源。

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

## 配置固定产物检查

生成 overlay 时可加 `--evidence-policy /path/to/checks.json`。部署文件为数组，规则匹配工作区的真实绝对路径、任务标题、条件 ID 和完整原文。对于工作台表单创建的任务，验收条件的 ID 是 `criterion-1`、`criterion-2` 等，顺序与表单一致。路径以工作区为基准，须指向当前提交选中的文件。支持 `nonempty` 和 `json`，后者要求合法 UTF-8 JSON，最多 1 MiB。

```json
[{
  "workspace": "/absolute/path/to/workspace",
  "taskTitle": "汇总销售数据",
  "criterionId": "criterion-1",
  "description": "JSON 格式有效",
  "path": "outputs/report.json",
  "check": "json"
}]
```

在已有命令末尾追加该选项，可以同时保留第三个位置参数的用量配置。修改规则后重启独立 profile。移除配置可恢复逐项人工验收，历史提交流程仍能读取已保存的证据。

升级审阅回送前停止同一 profile 上的旧 Workbench，备份任务存储及原生会话。启动新 Host 时为旧 Run 记录原生截止游标。通过任务内「核对回送」重复原请求。历史 ID 与正文冲突、日志无法读全或结果尚无证据时，保留现有状态并在原会话核对。回退使用升级前同一份任务与会话备份。 [审阅兼容设计](design/M3-BOUNDED-REVIEW.md)
