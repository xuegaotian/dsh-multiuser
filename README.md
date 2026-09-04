# dsh-multiuser

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多用户入口插件集成：为每名登录用户启动一个独立的 DSH Runtime，并提供统一认证网关、账号管理、管理员控制台和公共资源（模型 / Skill / 插件 / MCP）分发。

- `packages/bundle/user-runtime` 是真正由 DeepSeek Harness 加载的 DSH Bundle。
- 本项目的 Gateway、账号管理和 Runtime Manager 是围绕该 Bundle 的控制面，不是第二套 Harness。
- 每个用户进程启动时都执行原版 DSH，并通过 `--profile user-runtime` 读取这个 Bundle。

当前实现通用 Ed25519 SSO 普通用户会话、独立本地管理员会话、单机 Runtime Manager、认证网关和管理员只读管理入口。普通用户必须向 `/auth/sso` 提交由可信 IdP 签发的短期 JWT；管理员仅通过 `/admin/login` 使用本地密码登录，两种 Cookie 互不覆盖。

> **安全边界**：本项目提供每用户目录、会话和 Runtime 进程路由，但**不是**对抗恶意租户的操作系统级沙箱。当前版本面向可信内部用户。不要把本方案当作强多租户隔离。

## 功能

- **每用户隔离**：独立 `DSH_HOME`、workspace、日志目录、XDG/npm/pnpm 缓存和动态回环端口；同一用户的并发启动请求共享一个 Promise。
- **双层认证**：Gateway 负责登录、权限和路由；用户 Runtime 只绑定回环地址，并通过 DSH 的 `dsh-auth-*` Cookie 做内部 token 交换。
- **管理员控制台**：只读查看用户/Runtime/会话，维护公共模型、公共 Skill、公共插件和公共 MCP。
- **公共资源分发**：公共配置写入共享模板，在每个用户 Runtime 下次启动前合并，不覆盖用户私有依赖与配置。
- **本地账号管理 CLI**：初始化管理员、创建/禁用用户、重置密码、绑定 SSO 身份、安装并校验 Profile。

## 目录结构

```text
src/                  # Gateway、认证、Runtime Manager、Profile 安装等控制面
packages/bundle/      # 由 DSH 加载的 user-runtime Bundle
profiles/user-runtime # 每用户 Runtime 使用的 DSH Profile
deploy/               # systemd 单元与网关环境变量示例
scripts/              # 本机开发用的启停脚本
test/                 # Vitest 测试
```

## 开发

需要 Node.js >= 22.19.0 和 pnpm。

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## 快速开始

1. 准备 DSH 的构建目录：

   ```sh
   pnpm install
   pnpm --dir /path/to/deepseek-harness build
   ```

2. 初始化管理员账号（密码交互输入，不进入命令行）：

   ```sh
   pnpm dsh-multiuser init-admin --db ./data/gateway.sqlite --username admin --display-name Admin
   ```

3. 启动网关（本机开发）：

   ```sh
   pnpm gateway \
     --db ./data/gateway.sqlite \
     --data-root ./data/users \
     --dsh-command node \
     --dsh-args '[]' \
     --launcher-cwd /path/to/deepseek-harness \
     --launcher-entry /path/to/deepseek-harness/apps/cli/lib/bin.js \
     --profile user-runtime \
     --profile-source ./profiles/user-runtime \
     --host 127.0.0.1 \
     --port 18088 \
     --allowed-host 127.0.0.1:18088 \
     --insecure-cookies
   ```

   或使用管理脚本（默认读取旁边的 `deepseek-harness`、`./data`、`127.0.0.1:18088`）：

   ```sh
   ./scripts/dsh-multiuser.sh start
   ./scripts/dsh-multiuser.sh status
   ```

本机开发使用 `--insecure-cookies`；生产环境移除该选项并由 Ingress 提供 HTTPS。

## 认证

### 本地管理员

管理员使用独立的 `/admin/login` 路由和独立 Cookie，通过 Argon2id 本地密码登录，进入 `/admin` 控制台。

### SSO 普通用户

普通用户通过 `POST /auth/sso` 提交一个由可信 IdP 签发的**短期 Ed25519 JWT**，验证后按 `issuer + subject` 查找或创建普通用户，并设置普通用户 Cookie。

启用 SSO 需要同时提供以下网关参数（缺一不可）：

```sh
--sso-public-key <kid>=/absolute/key.pem \
--sso-issuer <issuer> \
--sso-audience <audience> \
--sso-origin <https://idp.example.com>
```

`--sso-public-key` 可重复，用于密钥轮换；`kid` 与 JWT 头部一致，公钥为 PEM 格式的 Ed25519 SPKI。

JWT 要求：

- 头部：`alg=EdDSA`、`typ=JWT`、`kid` 与已配置公钥一致。
- Claims：`iss`（issuer）、`aud`（audience）、`sub`（UUID）、`preferred_username`、`name`、`jti`（UUID，单次使用）、`iat=nbf`、`exp`。
- token 生命周期不超过 60 秒，且不得携带 `role` / `admin` / `permissions` 等特权 claims。

管理员永远只能通过本地密码登录，SSO JWT 不能创建或提升管理员。完整的协议与集成说明见 [docs/sso-integration-plan.md](docs/sso-integration-plan.md)。

### 绑定已有本地用户到 SSO 身份

```sh
pnpm dsh-multiuser link-sso-user \
  --db ./data/gateway.sqlite \
  --local-username alice \
  --issuer example-idp \
  --subject <uuid> \
  --sso-username alice \
  --confirm
```

## 安装到 DeepSeek Harness

如果 Harness 中已经存在包含 `base` 和 `web-app` 的 `user-runtime` Profile，可以直接使用 Harness 的标准插件命令追加本 Bundle：

```sh
dsh plugin --profile user-runtime add /path/to/dsh-multiuser/packages/bundle/user-runtime
dsh --profile user-runtime --dump-config
```

也可以使用本项目的安装入口（内部仍调用上述 DSH 命令，并在安装后执行 `--dump-config` 校验）：

```sh
pnpm install-profile \
  --dsh-command node \
  --dsh-args '["/path/to/deepseek-harness/apps/cli/lib/bin.js"]' \
  --dsh-cwd /path/to/deepseek-harness \
  --dsh-home /srv/dsh-multiuser/harness-home \
  --profile-source /srv/dsh-multiuser/app/profiles/user-runtime
```

安装完成后，Harness 的 Profile 中应能看到 `@dsh-multiuser/user-runtime-bundle`，而不是把整个 `dsh-multiuser` 当作 DSH 启动。

## 单机部署

建议将以下目录放在同一台受控主机的专用目录中，并限制 Gateway 服务账号权限：

```text
/srv/dsh-multiuser/
  app/                 # 本项目和依赖
  data/gateway.sqlite  # 账号、会话、审计和 Runtime 控制状态
  data/users/<id>/     # 每个 Principal ID 的 DSH_HOME、workspace、logs
```

由 systemd、Supervisor 或同等进程管理器启动 Gateway。仓库提供了 [deploy/dsh-multiuser.service](deploy/dsh-multiuser.service) 和 [deploy/gateway.env.example](deploy/gateway.env.example) 模板；使用前将 `dsh.example.com`、DSH 安装目录和 Node 路径替换为实际值。

管理员登录后会自动进入 `/admin`，可在"公共模型"中统一保存 `DEEPSEEK_API_KEY` 和可选的 `DEEPSEEK_BASE_URL`。它们写入数据库同目录的 `gateway.env`（权限 `0600`），不会写入 SQLite、审计日志或用户 workspace。Runtime 启动环境会保留公共 DeepSeek 变量，同时过滤其他名称中包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN` 的父环境变量。

- **公共插件**：管理员填写包名或本机路径时，Gateway 在共享模板 Home 中直接运行 `dsh plugin --profile user-runtime add <spec>`；"安装并校验 Profile"运行 `dsh plugin --profile user-runtime install` 和 `dsh --profile user-runtime --dump-config`。用户私有的依赖、Bundle、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 和 `cordis.patch.yml` 会被保留。
- **公共 MCP**：管理 DSH 官方 `@deepseek-ai/dsh-mcp-client` 的 stdio 与 Streamable HTTP 连接，保存为 `data/users/public-mcp.cordis.yml`（权限 `0600`），管理 API 只返回环境变量名与 HTTP 标头名，不返回值。
- **公共 Skill**：保存到 `data/users/public-agents/skills/<name>/`，Runtime 通过 `DSH_AGENTS_HOME` 发现；同名时用户私有 Skill 优先。

生产构建建议使用构建后的入口：

```sh
pnpm build
pnpm --dir /path/to/deepseek-harness build
pnpm gateway:dist \
  --db /srv/dsh-multiuser/data/gateway.sqlite \
  --data-root /srv/dsh-multiuser/data/users \
  --dsh-command node \
  --dsh-args '[]' \
  --launcher-cwd /path/to/deepseek-harness \
  --launcher-entry /path/to/deepseek-harness/apps/cli/lib/bin.js \
  --profile user-runtime \
  --profile-source /srv/dsh-multiuser/app/profiles/user-runtime \
  --host 127.0.0.1 \
  --port 18088 \
  --allowed-host 127.0.0.1:18088
```

首次部署后执行：

```sh
sudo useradd --system --home-dir /srv/dsh-multiuser --shell /usr/sbin/nologin dsh-multiuser
sudo install -d -o dsh-multiuser -g dsh-multiuser -m 700 /srv/dsh-multiuser/data/users /etc/dsh-multiuser
sudo install -o dsh-multiuser -g dsh-multiuser -m 600 deploy/gateway.env.example /etc/dsh-multiuser/gateway.env
# 编辑 /etc/dsh-multiuser/gateway.env 填入模型密钥，再执行构建和初始化。
pnpm dsh-multiuser init-admin --db /srv/dsh-multiuser/data/gateway.sqlite --username admin --display-name Admin
sudo install -m 644 deploy/dsh-multiuser.service /etc/systemd/system/dsh-multiuser.service
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-multiuser
sudo systemctl status dsh-multiuser
```

生产外部 TLS 由 Ingress 负责，公钥文件可放在 `/etc/dsh-multiuser/keys/` 并仅授权服务账号读取，**绝不能部署签发私钥**。代理必须将 `/auth/sso` 的请求体限制为 8 KiB，且不得记录 Cookie 或 POST body。

## 备份与回滚

停止 Gateway 后备份 `data/gateway.sqlite`、SQLite WAL/SHM 文件和 `data/users/`。恢复时必须同时恢复数据库和用户目录，避免账号状态与 Runtime 数据不一致。SSO 升级会把 SQLite Schema 迁移到版本 2；旧版本代码不能打开该数据库，回滚必须恢复同一份版本 1 数据库备份。

## 贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全漏洞请按 [SECURITY.md](SECURITY.md) 报告，不要公开披露。

## License

[MIT](LICENSE)
