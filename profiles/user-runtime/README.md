# `user-runtime` Profile

这是 DeepSeek Harness 的用户 Runtime Profile。它不是第二套 Harness：`packages/bundle/user-runtime` 是由 Harness 读取的 DSH Bundle，账号、Gateway 和 Runtime 生命周期由本项目负责。

默认 Profile 保留 Harness 原生 `dsh-base` 和 `dsh-web-app` 的完整组合，只额外安装 `@dsh-multiuser/user-runtime-bundle`。第三方插件和 Skill 由管理员或用户在容器启动后按需安装，并保存在部署的持久卷中。

在已经存在 base 和 web-app 的 Harness Profile 中，用 DSH 的标准插件命令安装 Bundle：

```sh
dsh plugin --profile user-runtime add \
  /path/to/dsh-multiuser/packages/bundle/user-runtime
dsh --profile user-runtime --dump-config
```

第一条命令会把 Bundle 写入 `$DSH_HOME/profiles/user-runtime/package.json`，并把它加入 `dsh.profile.bundles`；第二条命令验证 Harness 能解析并加载 Bundle 的 `cordis.patch.yml`。

本项目的 Gateway 为每个登录用户启动一个独立 DSH Runtime，并为每个 Runtime 准备独立的 `DSH_HOME`。因此生产部署不能只在管理员的默认 Harness home 中安装一次；请使用项目提供的 `install-profile` 命令为部署使用的 Harness home 安装并验证，或让 Gateway 按本项目的 Profile 源目录准备每个用户 home。

Gateway 管理的公共 MCP 不属于 Profile 自身，也不写入用户 patch。它在 Runtime 启动前复制到该用户 `$DSH_HOME/.dsh-multiuser/public-mcp.cordis.yml`，再作为独立的 DSH `--patch` 层加载；用户自己的 Profile、插件与 MCP 配置仍由用户 Home 持有。

便捷安装命令内部调用 DSH 的 `plugin --profile user-runtime install`，然后执行 `--dump-config` 校验：

```sh
pnpm install-profile \
  --dsh-command node \
  --dsh-args '["/path/to/deepseek-harness/apps/cli/lib/bin.js"]' \
  --dsh-cwd /path/to/deepseek-harness \
  --dsh-home /srv/dsh-multiuser/harness-home \
  --profile-source /srv/dsh-multiuser/app/profiles/user-runtime
```
