# Gateway Profile

Gateway 是本插件集成的控制面进程，不运行在任意用户 DSH Runtime 的 `DSH_HOME` 中。它不是第二套 Harness，也不替代 DSH 的插件加载；它负责登录、用户 Runtime 生命周期和请求透明转发。

启动入口是项目根目录的 `pnpm gateway`。它只监听配置的统一入口地址，按登录用户把请求转发到回环 Runtime；`profiles/user-runtime` 是每个用户 Runtime 使用的 DSH Profile，里面的 `@dsh-multiuser/user-runtime-bundle` 由 DeepSeek Harness 加载。

安装并验证 Bundle：

```sh
pnpm install-profile \
  --dsh-command node \
  --dsh-args '["/srv/deepseek-harness/apps/cli/lib/bin.js"]' \
  --dsh-cwd /srv/deepseek-harness \
  --dsh-home /srv/dsh-multiuser/harness-home \
  --profile-source /srv/dsh-multiuser/app/profiles/user-runtime
```

在已有 Profile 中，等价的 Harness 原生命令是 `dsh plugin --profile user-runtime add /path/to/packages/bundle/user-runtime`，之后由 `dsh --profile user-runtime` 启动和加载。对本项目的全新部署，应使用上面的便捷命令，因为当前 Harness 的 web-app 组合包含本地构建依赖。Gateway 的每用户 home 准备逻辑只是把同一份已版本化 Profile 和 Bundle 放入隔离目录，确保每个 Runtime 都能完成相同的 DSH 解析。

生产环境应由现有 HTTPS 反向代理转发到 Gateway，本机开发使用 `--insecure-cookies` 和 `127.0.0.1`。Gateway 进程环境只应提供 `DEEPSEEK_API_KEY`、可选的 `DEEPSEEK_BASE_URL` 及运行所需普通变量；不要把其他凭据放进启动环境。

Runtime 的 `DEEPSEEK_API_KEY` 用于 DSH 的模型 credential reference。DSH 的 subprocess provider 会在 Shell/Terminal 子进程启动前清除凭据型环境变量，因此该变量不会作为隐式环境进入用户命令。此保证依赖所部署 DSH 版本继续使用当前 subprocess provider；升级 DSH 后应重新运行安全回归测试。
