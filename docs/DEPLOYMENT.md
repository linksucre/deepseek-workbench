# 本地部署与回滚

要求 Node 24.22.3、基线指定提交的 Harness 和它要求的 pnpm。上游目录与本仓库分别管理。

1. 根据 [harness-baseline.json](../harness-baseline.json) 准备上游干净 checkout，执行 `corepack pnpm install --frozen-lockfile` 和 `corepack pnpm run build`。
2. 在本仓库执行 `npm ci` 与 `npm run check`，再执行 `npm run test:smoke -- /path/to/built/deepseek-harness`。
3. 在构建后的 Harness checkout 执行下列命令。补丁地址填写本仓库的真实绝对路径。

```sh
DSH_HOME="$HOME/Library/Application Support/DeepSeek Harness Workbench" \
  corepack pnpm dsh --profile web --patch /path/to/deepseek-workbench/src/preset/cordis.patch.yml \
  --host 127.0.0.1 --port 3081
```

在空白会话选「任务协作」。真实模型由部署者按 Harness 的方式在独立数据目录提供凭据。启动日志包含临时登录链接，保存在本机受限文件中。备份业务数据时仅导出授权记录。

回滚前停止当前服务，备份 Harness 独立数据目录。使用去掉补丁的同版本 Web profile 验证标准预设；需要继续打开使用任务协作预设的现有会话时，使用原版本补丁重启。M1 开始引入任务存储后，按 [数据库文档](../DATABASE.md) 验证备份恢复再启用旧版本。

远端发布先跑测试与安装复核。当前私有 manifest 供本地开发，发布形态需通过上游安装能力工单确认。
