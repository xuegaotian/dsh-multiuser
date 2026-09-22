# dsh-multiuser

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多用户入口插件集成：为每名登录用户启动一个独立的 DSH Runtime，并提供统一认证网关、账号管理、管理员控制台和公共资源（模型 / Skill / 插件 / MCP）分发。

- `packages/bundle/user-runtime` 是真正由 DeepSeek Harness 加载的 DSH Bundle。
- 本项目的 Gateway、账号管理和 Runtime Manager 是围绕该 Bundle 的控制面，不是第二套 Harness。
- 每个用户进程启动时都执行原版 DSH，并通过 `--profile user-runtime` 读取这个 Bundle。

当前实现通用 Ed25519 SSO 普通用户会话、独立本地管理员会话、单机 Runtime Manager、认证网关和管理员只读管理入口。普通用户必须向 `/auth/sso` 提交由可信 IdP 签发的短期 JWT；管理员仅通过 `/admin/login` 使用本地密码登录，两种 Cookie 互不覆盖。

> **支持版本**：本版本已实测 DeepSeek Harness `0.1.5-rc.1`（npm `latest`，通过真实 Runtime 集成测试）与 `0.1.6-alpha.1`（npm `alpha`，前瞻验证）。精确的已验证版本列表见 [`compatibility.json`](compatibility.json)；不支持早于 `0.1.5-rc.1` 的版本。CI 通过 `unit`、`integration-latest`、`integration-alpha` 三类作业保持该矩阵（见 [CI 工作流](.github/workflows/ci.yml)）。

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

`pnpm test` 只运行单元测试（不依赖真实 DSH）。真实 DSH Runtime 集成测试通过 `pnpm test:integration` 运行，需要先用 `DSH_INTEGRATION_BIN` 指向一个已安装的 `dsh` 可执行文件：

```sh
mkdir -p compat-work && cd compat-work
npm init -y >/dev/null
npm install --save-exact @deepseek-ai/dsh@0.1.5-rc.1
cd ..
DSH_INTEGRATION_BIN="$PWD/compat-work/node_modules/.bin/dsh" \
DSH_INTEGRATION_VERSION="0.1.5-rc.1" \
  pnpm test:integration
```

集成测试覆盖：Runtime 启动与 token 交换、`dsh-auth-*` Cookie 认证、`/api` RPC envelope（`session/list`、`session/search`、`session/page`、`session/create`、`subagents/list`）、`/api/remote.mux` WebSocket、双用户隔离，以及完整 Gateway（SSO 登录 → 启动用户 Runtime → 代理 HTTP/RPC/WebSocket）链路。所有测试 home 都在临时目录中，不会读写维护者的默认 `DSH_HOME`。

## 开源发布准备

本仓库尚未完成正式公开发布验收。DSH 版本兼容（手册第 1 章）已完成：真实 Runtime 集成测试与 CI 矩阵已落地，见 [DSH 兼容升级](docs/open-source-release/01-dsh-compatibility.md)。维护者请继续从 [开源发布实施手册](docs/open-source-release/README.md) 第 2 章开始，依次完成发布包安装、生产部署和发布验收。手册中标记为“待实施”的命令和产物是发布目标，不代表当前代码已提供。

## 快速开始

推荐使用 npm 发布的 `dsh` CLI（无需本地 Harness checkout）：

1. 安装指定版本的 DSH 并初始化管理员账号：

   ```sh
   mkdir dsh-multiuser-deploy && cd dsh-multiuser-deploy
   npm init -y >/dev/null
   npm install --save-exact @deepseek-ai/dsh@0.1.5-rc.1
   ```

   在本仓库目录中执行（密码交互输入，不进入命令行）：

   ```sh
   pnpm install
   pnpm dsh-multiuser init-admin --db ./data/gateway.sqlite --username admin --display-name Admin
   ```

2. 启动网关（本机开发，直接使用 npm 安装的 `dsh` 命令，无需 `--launcher-entry`）：

   ```sh
   pnpm gateway \
     --db ./data/gateway.sqlite \
     --data-root ./data/users \
     --dsh-command "$PWD/../dsh-multiuser-deploy/node_modules/.bin/dsh" \
     --dsh-args '[]' \
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

也可以继续使用本地 Harness checkout 方式（`--launcher-cwd` + `--launcher-entry` 指向 checkout 的 `apps/cli/lib/bin.js`），两种方式都受支持；npm 方式不需要维护 checkout。

## 安装、检查与卸载（dsh-multiuser CLI）

发布包提供生命周期命令（详见 `dsh-multiuser <command> --help`）：

```sh
# 只读环境检查：Node/DSH 版本、compatibility.json 匹配、目录权限、
# Profile 真实 --dump-config 组合验证、SSO 完整性、安全 Cookie 提醒。
# 稳定结果码（NODE_VERSION、DSH_COMPATIBILITY、PROFILE_COMPOSITION、
# SSO_CONFIG 等）便于脚本处理；--json 输出机器可读格式；不创建任何文件。
dsh-multiuser doctor \
  --dsh-command /path/to/dsh \
  --db /srv/dsh-multiuser/data/gateway.sqlite \
  --data-root /srv/dsh-multiuser/data/users \
  --profile-source /srv/dsh-multiuser/app/profiles/user-runtime

# 幂等安装：staging → 真实 --dump-config 验证 → 原子替换应用目录，
# 数据目录保留；重复执行不覆盖账号与数据；--dry-run 只显示计划。
dsh-multiuser install --mode local \
  --app-dir /srv/dsh-multiuser/app \
  --data-dir /srv/dsh-multiuser/data \
  --dsh-command /path/to/dsh \
  --profile-source ./profiles/user-runtime \
  --dry-run

# 预览版不提供在线 upgrade 命令。生产升级必须先停止服务，
# 再执行 backup，安装新版本，启动服务并验证 /readyz 与版本。
sudo systemctl stop dsh-multiuser
dsh-multiuser backup --db /srv/dsh-multiuser/data/gateway.sqlite --data-root /srv/dsh-multiuser/data/users --to /srv/dsh-multiuser/backups --config-dir /etc/dsh-multiuser
sudo npx dsh-multiuser@<新应用版本> install --mode systemd --app-dir /srv/dsh-multiuser/app --data-dir /srv/dsh-multiuser/data --dsh-command /path/to/dsh --dsh-args '[]' --profile-source /srv/dsh-multiuser/app/profiles/user-runtime --host 127.0.0.1 --port 18088 --allowed-host <网关域名> --service-user dsh-multiuser
sudo systemctl enable --now dsh-multiuser
dsh-multiuser status --db /srv/dsh-multiuser/data/gateway.sqlite --data-root /srv/dsh-multiuser/data/users --profile-source /srv/dsh-multiuser/app/profiles/user-runtime --dsh-command /path/to/dsh --port 18088
# 卸载默认保留数据；--purge-data 拒绝根目录/用户 home/工作区根目录。
dsh-multiuser uninstall --app-dir /srv/dsh-multiuser/app --data-dir /srv/dsh-multiuser/data

# 网关状态与启停辅助。
dsh-multiuser status --db /srv/dsh-multiuser/data/gateway.sqlite --data-root /srv/dsh-multiuser/data/users --profile-source /srv/dsh-multiuser/app/profiles/user-runtime --dsh-command /path/to/dsh --port 18088
```

`install --mode systemd` 额外生成 systemd unit（输出拷贝到 `/etc/systemd/system/dsh-multiuser.service` 的命令提示，需要 root 执行）。首次安装后用 `init-admin` 创建管理员——它拒绝重复初始化。

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

管理员永远只能通过本地密码登录，SSO JWT 不能创建或提升管理员。完整的协议与集成说明见 [docs/sso-integration.md](docs/sso-integration.md)。

### 接入外部 IdP

Gateway 的 SSO 入口不绑定任何特定厂商或平台，任何能够签发符合上述要求的 Ed25519 JWT 的系统都可以作为身份源，例如企业 IdP、统一认证中心，或自建的运维 / 门户平台。

集成方（IdP 或平台侧）需要完成三件事：

1. **签发短期 JWT**：使用 Ed25519 私钥签发，`alg=EdDSA`，`kid` 与 Gateway 已配置的公钥一致，生命周期不超过 60 秒，并且每次签发使用新的 `jti`（单次使用，Gateway 会原子消费）。
2. **提供公钥**：把 Ed25519 公钥（PEM 格式 SPKI）以 `<kid>=<绝对路径>` 的形式交给 Gateway 的 `--sso-public-key`。私钥**永远不要**部署到 Gateway 主机。
3. **引导用户提交 token**：在平台页面中以 `POST` 表单把 JWT 提交到 `https://<gateway-host>/auth/sso`，并确保来源与该 Gateway 的 `--sso-origin` 一致。

最小可用的接入检查：

```sh
# 1. 生成一对测试用 Ed25519 密钥（生产环境使用你的 IdP 自己签发的那对）
#    用 Node 生成，避免依赖 OpenSSL 版本：部分平台（如 macOS 自带 LibreSSL）
#    不支持 Ed25519，openssl genpkey -algorithm Ed25519 会报
#    "Algorithm Ed25519 not found"。
node -e '
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
fs.writeFileSync("idp-private.pem", privateKey.export({ type: "pkcs8", format: "pem" }));
fs.writeFileSync("idp-public.pem", publicKey.export({ type: "spki", format: "pem" }));
'

# 2. 带 SSO 参数启动 Gateway（或写进 install 的 --sso-* 参数）
#    --sso-public-key my-kid=/etc/dsh-multiuser/keys/idp-public.pem \
#    --sso-issuer my-idp --sso-audience dsh-multiuser --sso-origin https://idp.example.com

# 3. 确认 SSO 配置被 doctor 认定为完整
dsh-multiuser doctor --dsh-command <dsh 路径> --db <db> --data-root <users> \
  --profile-source <app>/profiles/user-runtime \
  --sso-public-key my-kid=/etc/dsh-multiuser/keys/idp-public.pem \
  --sso-issuer my-idp --sso-audience dsh-multiuser --sso-origin https://idp.example.com
# 期望：SSO_CONFIG: SSO fully configured
```

未配置 SSO 时 Gateway 仍可启动，但普通用户无法登录（`doctor` 的 `SSO_CONFIG` 会失败并明确提示），此时只能使用本地管理员账号访问 `/admin`。

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

生产部署（Linux + systemd + HTTPS 反向代理）请按 [docs/open-source-release/03-production-deployment.md](docs/open-source-release/03-production-deployment.md) 逐步执行。目录布局与关键约束：

```text
/opt/dsh-multiuser/          # 应用目录（--app-dir，不可变）
  bin/dsh-multiuser          #   应用入口，install 创建
  dist/src/                  #   编译后的 Gateway 与 CLI
/var/lib/dsh-multiuser/      # 数据目录（--data-dir，可变）
  gateway.sqlite             #   账号、会话、审计和 Runtime 控制状态
  gateway.env                #   共享模型配置（管理员在控制台保存，0600）
  users/                     #   --data-root；每个 Principal ID 一个子目录
    <id>/{dsh-home,workspace,logs}
    profile-template/        #   共享模板 Profile home（也在 data-root 内）
    public-agents/ public-mcp.cordis.yml
/etc/dsh-multiuser/          # 配置目录
  gateway.env                #   systemd EnvironmentFile（0600）
  keys/<kid>.pem             #   SSO 公钥，仅服务账号可读
```

**systemd 单元由 `install --mode systemd` 直接写入 `/etc/systemd/system/`，不要手工拷贝模板**——手抄的副本会随安装器新增参数而悄悄过期。[deploy/dsh-multiuser.service](deploy/dsh-multiuser.service) 只是 `install --mode systemd --dry-run` 输出的样例，供评审使用：

```sh
sudo dsh-multiuser install --mode systemd \
  --app-dir /opt/dsh-multiuser --data-dir /var/lib/dsh-multiuser \
  --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --dsh-command <dsh 可执行路径> --dsh-args '[]' \
  --host 127.0.0.1 --port 18088 --allowed-host <网关域名> \
  --service-user dsh-multiuser
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-multiuser
```

`--allowed-host` 必须是 `ExecStart` 的最后一个参数，SSO 参数加在它之前。`--dsh-command` 指向 npm 发布的 DSH（`npm install --global @deepseek-ai/dsh@<版本>`），**生产不要依赖 Harness 源码 checkout**；`--launcher-cwd` / `--launcher-entry` 只用于从源码直跑的场景。

管理员登录后会自动进入 `/admin`，可在「公共模型」中统一保存 `DEEPSEEK_API_KEY` 和可选的 `DEEPSEEK_BASE_URL`。它们写入**数据库同目录**的 `gateway.env`（权限 `0600`，即 `/var/lib/dsh-multiuser/gateway.env`，与 systemd 的 `/etc/dsh-multiuser/gateway.env` 是两个文件），不会写入 SQLite、审计日志或用户 workspace。`backup` 会自动把它收进备份。Runtime 启动环境会保留公共 DeepSeek 变量，同时过滤其他名称中包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN` 的父环境变量。

- **公共插件**：管理员填写包名或本机路径时，Gateway 在共享模板 Home 中直接运行 `dsh plugin --profile user-runtime add <spec>`；"安装并校验 Profile"运行 `dsh plugin --profile user-runtime install` 和 `dsh --profile user-runtime --dump-config`。用户私有的依赖、Bundle、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 和 `cordis.patch.yml` 会被保留。
- **公共 MCP**：管理 DSH 官方 `@deepseek-ai/dsh-mcp-client` 的 stdio 与 Streamable HTTP 连接，保存为 `<data-root>/public-mcp.cordis.yml`（权限 `0600`），管理 API 只返回环境变量名与 HTTP 标头名，不返回值。
- **公共 Skill**：保存到 `<data-root>/public-agents/skills/<name>/`，Runtime 通过 `DSH_AGENTS_HOME` 发现；同名时用户私有 Skill 优先。

从源码直跑（开发/调试用，**不是生产路径**——生产用上面的 `install --mode systemd`）：

```sh
pnpm build
pnpm gateway:dist \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --data-root /var/lib/dsh-multiuser/users \
  --dsh-command node \
  --dsh-args '[]' \
  --launcher-cwd /path/to/deepseek-harness \
  --launcher-entry /path/to/deepseek-harness/apps/cli/lib/bin.js \
  --profile user-runtime \
  --profile-source profiles/user-runtime \
  --host 127.0.0.1 \
  --port 18088 \
  --allowed-host 127.0.0.1:18088
```

首次部署后执行（完整步骤见第 3 章手册）：

```sh
sudo useradd --system --home-dir /var/lib/dsh-multiuser --shell /usr/sbin/nologin dsh-multiuser
sudo install -d -o dsh-multiuser -g dsh-multiuser -m 0700 /var/lib/dsh-multiuser /var/lib/dsh-multiuser/users
sudo install -d -m 0755 /etc/dsh-multiuser /etc/dsh-multiuser/keys
printf 'correct-horse-battery-staple\n' | dsh-multiuser init-admin \
  --db /var/lib/dsh-multiuser/gateway.sqlite --username admin --display-name Admin --password-stdin
# 管理员密码至少 12 个字符，否则 init-admin 报错并非 0 退出。
# systemd 单元由 install 直接写入 /etc/systemd/system/，不要手工拷贝 deploy/ 里的样例：
sudo dsh-multiuser install --mode systemd \
  --app-dir /opt/dsh-multiuser --data-dir /var/lib/dsh-multiuser \
  --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --dsh-command <dsh 可执行路径> --dsh-args '[]' \
  --host 127.0.0.1 --port 18088 --allowed-host <网关域名> \
  --service-user dsh-multiuser
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-multiuser
dsh-multiuser status --db /var/lib/dsh-multiuser/gateway.sqlite \
  --data-root /var/lib/dsh-multiuser/users --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --dsh-command <dsh 可执行路径> --dsh-args '[]' \
  --host 127.0.0.1 --port 18088 --host-header <网关域名>
```

生产外部 TLS 由 Ingress 负责，公钥文件可放在 `/etc/dsh-multiuser/keys/` 并仅授权服务账号读取，**绝不能部署签发私钥**。代理必须将 `/auth/sso` 的请求体限制为 8 KiB，且不得记录 Cookie 或 POST body。

## 备份与恢复

停机后使用内置命令备份与恢复，不要手抄 `cp`：

```sh
dsh-multiuser backup \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --data-root /var/lib/dsh-multiuser/users \
  --to <备份目录> --config-dir /etc/dsh-multiuser

dsh-multiuser restore \
  --from <备份目录>/<时间戳> \
  --data-root /var/lib/dsh-multiuser/users \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --config-dir /etc/dsh-multiuser --force
```

`backup` 用 `VACUUM INTO` 做一致性快照，并一并收走 `<data-dir>/gateway.env`（共享模型配置）。`restore` 先校验 manifest 的 sha256 与 `PRAGMA quick_check`，任何校验失败都在写盘前中止；`--force` 把旧数据**移**到 `.pre-restore-<stamp>` 而非删除。`--data-root` 必须传 `users/` 这一级，传成上一级会让恢复后的用户数据全部不可见。SSO 升级会把 SQLite Schema 迁移到版本 2；旧版本代码不能打开该数据库，回滚必须同时恢复升级前的数据备份。

## 贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全漏洞请按 [SECURITY.md](SECURITY.md) 报告，不要公开披露。

## License

[MIT](LICENSE)
