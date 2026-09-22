---
title: dsh-multiuser SSO 协议与 IdP 接入参考
status: implemented
owner: dsh-multiuser
last_verified: 2026-09-17
---

# dsh-multiuser SSO 协议与 IdP 接入参考

## Summary

本文记录当前 SSO 普通用户登录、独立本地管理员登录、JWT 校验、用户映射、Runtime Cookie 交换和回滚约束。Gateway 接收浏览器 POST 的 60 秒 Ed25519 JWT，验证后按 `issuer + subject` 查找或创建普通用户，再复用现有 Gateway Session、Runtime Manager 和 Harness Runtime Cookie 交换。管理员使用独立路由和独立 Cookie 登录 `/admin`，SSO JWT 永远不能创建或提升管理员。本文以任意签发 Ed25519 JWT 的 IdP 为接入对象，协议不绑定特定厂商。

## Table of Contents

- [认证边界](#认证边界)
- [当前实现依据](#当前实现依据)
- [固定 JWT 协议](#固定-jwt-协议)
- [认证流程](#认证流程)
- [依赖和实现范围](#依赖和实现范围)
- [数据库模型](#数据库模型)
- [SSO 验证服务](#sso-验证服务)
- [Gateway 路由](#gateway-路由)
- [管理员入口保留](#管理员入口保留)
- [CLI 和配置](#cli-和配置)
- [验证覆盖范围](#验证覆盖范围)
- [维护与发布验证](#维护与发布验证)
- [验收标准](#验收标准)
- [上线和回滚](#上线和回滚)
- [禁止事项](#禁止事项)
- [Dev Note](#dev-note)

-----

## 认证边界

Gateway 接受两种认证来源，但每条路由只接受一种明确的会话 Cookie。

| 入口 | 身份来源 | 允许角色 | 登录结果 |
|---|---|---|---|
| `POST /auth/sso` | IdP Ed25519 JWT | 仅 `user` | 设置普通用户 Cookie，`303 /` |
| `GET /admin/login` | Gateway 本地账号 | 仅 `admin` | 显示管理员登录页 |
| `POST /admin/auth/login` | Gateway 本地 Argon2id 密码 | 仅 `admin` | 设置管理员 Cookie，返回成功 |

当前行为：

- IdP 用户首次登录时即时创建普通 Gateway 用户。
- 后续登录按 `issuer + subject` 找到同一个 Gateway UUID。
- Runtime Manager 继续只接收 Gateway UUID，不接收用户名或 JWT subject。
- 普通用户和管理员可以在同一浏览器中同时保有独立会话。
- 现有管理员只读管理规则、Runtime 隔离和 Harness `dsh-auth-*` 交换继续生效。

非目标：

- 本阶段不接受 IdP 角色作为管理员授权依据。
- 本阶段不实现 IdP 主动撤销 Gateway Session。
- 本阶段不修改 DeepSeek Harness 源码。
- 本阶段不把 Gateway Session 当作 Harness Runtime Cookie；两层认证继续分离。

## 当前实现依据

当前实现包含以下机制。

| 当前机制 | 位置 | 约束 |
|---|---|---|
| 本地账号、Argon2id、登录 Session 和审计 | `src/auth-local.ts` | 外部身份复用同一 Session 存储，不复制认证实现 |
| 普通用户 Cookie `dsh_multiuser_session` | `src/gateway.ts` | 仅用于普通用户页面、API 和 Remote WebSocket |
| `/auth/sso` 与 `/admin/auth/login` | `src/gateway.ts` | SSO 只创建普通用户；管理员只使用本地密码入口 |
| 管理员 Cookie | `src/gateway.ts` | 只控制 `/admin`，不能访问普通 Runtime |
| Runtime 按内部 `user.id` 路由 | `src/runtime-manager.ts` | 不改为用户名或外部 subject 路由 |
| Runtime token 换取 `dsh-auth-*` Cookie | `src/gateway.ts` 的 `ensureRuntime()` | SSO 成功后复用，不改变内部握手 |
| Host/Origin 校验 | `src/gateway.ts` 的 `isTrustedRequest()` | `/auth/sso` 使用配置的精确 Origin，其他路由使用 Gateway Origin |

认证实现不信任浏览器提交的用户标识；Runtime 始终按 Gateway 内部用户 UUID 路由。

## 固定 JWT 协议

Gateway 与 IdP 必须实现完全相同的协议。字段或算法变化需要同时修改两份方案和两边测试。

### JWT 头部

```json
{
  "alg": "EdDSA",
  "typ": "JWT",
  "kid": "sso-2026-01"
}
```

### JWT Claims

```json
{
  "iss": "example-idp",
  "aud": "dsh-multiuser",
  "sub": "7d2188de-7dde-4ac9-b724-e32d283b0644",
  "preferred_username": "zhangsan",
  "name": "张三",
  "iat": 1787890000,
  "nbf": 1787890000,
  "exp": 1787890060,
  "jti": "a random UUID"
}
```

Gateway 验证要求：

- `alg` 必须为 `EdDSA`，验证库只允许该算法。
- `kid` 必须命中配置的公钥；未知 `kid` 直接拒绝。
- `iss`、`aud` 必须精确匹配配置。
- `sub`、`preferred_username`、`name` 和 `jti` 必须存在且为非空字符串。
- `sub` 和 `jti` 必须是标准 UUID 字符串。
- `name` 最长 120 个 Unicode 字符，`preferred_username` 最长 64 个字符。
- `iat`、`nbf`、`exp` 必须存在；`exp - iat` 不得超过 60 秒。
- 允许最多 5 秒时钟偏差，token 总年龄不得超过 70 秒。
- JWT 中出现 `role`、`admin`、`permissions` 或等价管理员声明时直接拒绝，而不是忽略。

### HTTP 交换

```http
POST /auth/sso
Origin: https://sso.example.com
Content-Type: application/x-www-form-urlencoded

token=<compact JWT>
```

成功：

```http
HTTP/1.1 303 See Other
Location: /
Set-Cookie: dsh_multiuser_session=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/
Cache-Control: no-store
Referrer-Policy: no-referrer
```

失败返回 HTML 安全错误页或 JSON 通用错误，状态分别为 `400`、`401`、`403`、`413` 或 `421`。响应不得回显 token、claims、签名失败细节或内部用户 ID。

-----

## 认证流程

```text
IdP 页面
  -> POST JWT 到 /auth/sso
  -> Gateway 校验 Host 和该端点专用 Origin
  -> Gateway 校验 Ed25519 签名、kid、issuer、audience、时间和 claims
  -> Gateway 原子消费 jti
  -> AuthStore.findOrCreateExternalUser(issuer, subject, username, displayName)
  -> AuthStore.createSession(userId, source='sso')
  -> 设置普通用户 Cookie
  -> 303 /
  -> ensureRuntime(Gateway internal user UUID)
  -> Gateway 与 Runtime 完成 launch token / dsh-auth-* Cookie 交换
  -> 代理页面、RPC 和 /api/remote.mux
```

任何失败发生在创建 Gateway Session 和启动 Runtime 之前。签名无效、token 过期、重复 `jti` 或 Origin 不可信时不得创建用户、Session、Runtime 记录或用户目录。

-----

## 依赖和实现范围

### 依赖

`package.json` 和 `pnpm-lock.yaml` 声明 `jose` 运行时依赖。实现使用 `jose.importSPKI()` 导入 Ed25519 公钥，并使用 `jose.jwtVerify()` 验证 JWT；代码不自行实现 JWT 解析、Base64URL、Ed25519 或 claims 时间校验。

### 实现文件

```text
src/sso.ts
test/sso.test.ts
```

### 相关文件

```text
package.json
pnpm-lock.yaml
src/auth-local.ts
src/gateway.ts
src/gateway-cli.ts
src/cli.ts
src/admin-page.ts
src/admin-login-page.ts
test/auth-local.test.ts
test/gateway.test.ts
deploy/gateway.env.example
deploy/dsh-multiuser.service
README.md
```

`src/runtime-manager.ts` 和 Harness Bundle 不承担 SSO 身份映射；Runtime 始终使用 Gateway 内部用户 UUID。

-----

## 数据库模型

数据库迁移必须保留现有本地管理员、普通用户、登录 Session、Runtime 记录、审计和用户目录。

### Schema 版本

使用 SQLite `PRAGMA user_version` 建立明确版本：

- 当前无版本数据库视为版本 `1`。
- SSO 数据库版本为 `2`。
- 新数据库直接创建版本 `2` Schema。
- 旧数据库在一个 `BEGIN IMMEDIATE` 事务内迁移到版本 `2`。
- 数据库版本高于代码支持版本时启动失败，不尝试降级。

### `users` 新列

```sql
ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'
  CHECK (auth_source IN ('local', 'sso'));
ALTER TABLE users ADD COLUMN external_issuer TEXT;
ALTER TABLE users ADD COLUMN external_subject TEXT;
ALTER TABLE users ADD COLUMN external_username TEXT;
```

当前索引：

```sql
CREATE UNIQUE INDEX users_external_identity_idx
ON users(external_issuer, external_subject)
WHERE external_issuer IS NOT NULL AND external_subject IS NOT NULL;
```

应用层额外维护以下不变量：

- `auth_source='local'` 时外部身份列全部为 `NULL`。
- `auth_source='sso'` 时 issuer、subject 和 external username 全部非空，`role` 必须为 `user`。
- 外部身份不得切换为本地身份，本地管理员不得绑定外部 subject。

SQLite 的 `users.password_hash` 当前为 `NOT NULL`。版本 2 不重建表；SSO 用户写入一个随机、不可登录的 Argon2id hash，并由管理员认证查询先检查 `auth_source='local' AND role='admin'`，所以 SSO 密码 hash 永远不进入验证路径。该随机原文不得返回、记录或保存。

### Session 来源

`login_sessions` 包含：

```sql
ALTER TABLE login_sessions ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'
  CHECK (auth_source IN ('local', 'sso'));
```

`createSession(userId, authSource, expiresAt?)` 统一创建原始 Session ID、hash、时间和审计。SSO Session TTL 默认 1 小时，本地管理员 Session TTL 保持当前配置；两者都不得超过全局最大 TTL。

### 外部用户查找或创建

`AuthStore` 提供：

```ts
findOrCreateExternalUser(input: {
  issuer: 'example-idp'
  subject: string
  username: string
  displayName: string
}, audit?: AuditContext): Promise<User>
```

行为约束：

1. 使用 `issuer + subject` 查询，绝不按 username 或 display name 认领用户。
2. 第一次登录在事务中创建内部 UUID、普通用户和不可登录 password hash。
3. 内部 `users.username` 使用 `sso-<normalized username>`；冲突时追加 subject hash 的短后缀。
4. 后续登录同步 `external_username` 和 `display_name`，但保持内部 UUID 不变。
5. 用户被 Gateway 管理员禁用时，SSO 登录返回禁用结果，不自动重新启用。
6. 并发首次登录依赖唯一索引收敛到同一个用户；约束冲突后重新查询，不创建第二个目录。
7. 审计记录 `sso.user.create`、`sso.user.refresh` 或 `sso.login.denied`，不记录 JWT 或完整 claims。

### 现有本地普通用户

现有本地用户保持 `auth_source='local'`，不会按用户名自动合并。需要保留某个本地用户历史数据时，使用显式 CLI：

```text
link-sso-user --db <path> --local-username <name> --issuer <issuer> --subject <uuid> --sso-username <name> --confirm
```

该命令仅允许绑定 `role=user` 的本地用户，执行前要求确认，绑定后撤销该用户全部本地 Session，并把 `auth_source` 改为 `sso`。管理员账号永远不能执行该绑定。

-----

## SSO 验证服务

`src/sso.ts` 集中管理公钥、协议校验和短期 replay 状态。

接口：

```ts
export interface OpsIdentity {
  issuer: 'example-idp'
  subject: string
  username: string
  displayName: string
  tokenId: string
  expiresAt: number
}

export interface SsoVerifierOptions {
  issuer: string
  audience: string
  keys: ReadonlyMap<string, CryptoKey>
  allowedOrigin: string
  now?: () => number
}

export class SsoVerifier {
  verify(token: string): Promise<OpsIdentity>
  consume(tokenId: string, expiresAt: number): boolean
}
```

行为约束：

- 构造时解析所有公钥，密钥文件缺失、`kid` 重复或不是 Ed25519 时 Gateway 启动失败。
- `verify()` 先读取 protected header 选择已配置 `kid`，然后使用 `jwtVerify()` 固定验证 EdDSA、issuer 和 audience。
- 对 claims 做类型、长度、UUID、时间窗口和禁止管理员字段检查。
- `consume()` 使用进程内 `Map<jti, expiresAt>` 原子拒绝当前进程中的重复 token。
- 每次 consume 前清理已过期 `jti`，Map 不持久化；Gateway 重启后的最大重放窗口仍受 60 秒 token TTL 限制。
- 错误对外统一为 `invalid or expired sign-in token`，内部日志只记录错误类别和 request ID。

不要先解析 payload 并据此创建用户，再验证签名。未验证 token 的任何字段都不能进入数据库、日志、路径或响应。

-----

## Gateway 路由

### GatewayOptions

在 `GatewayOptions` 增加可选 `sso?: SsoVerifier`。未配置 SSO 时 `/auth/sso` 返回 `404`，本地管理员仍可使用。

### Host 和 Origin

`isTrustedRequest()` 先验证 Gateway Host；仅 `POST /auth/sso` 接受 `SsoVerifier.allowedOrigin` 的完整 origin，以支持受信任 IdP 的跨站表单。

规则：

- Host 始终必须位于 `allowedHosts`。
- `/auth/sso` 必须存在 Origin，且 scheme、host、port 与配置完全相等。
- 其他 HTTP 和 WebSocket 路由继续只接受 Gateway 自身 Origin。
- 不设置宽泛 CORS；HTML form POST 不需要 CORS。
- 不信任 `Referer`、`X-Forwarded-Host` 或调用方提交的用户 header。

### 表单解析

受限 `readForm()`：

- 只接受 `application/x-www-form-urlencoded`。
- body 上限 8 KiB。
- 只允许一个 `token` 字段。
- 空 token、重复字段、额外字段或错误 Content-Type 返回 `400`。
- 超限返回 `413`。

### SSO handler

处理顺序固定为：

1. 验证 Gateway Host 和 IdP Origin。
2. 读取受限表单。
3. 验证 JWT。
4. 原子消费 `jti`；重复 token 返回 `401`。
5. 查找或创建外部普通用户。
6. 检查用户仍为 enabled 且 role 为 user。
7. 创建 `auth_source='sso'` 的 1 小时 Gateway Session。
8. 写普通用户 Cookie并返回 `303 /`。

handler 不直接启动 Runtime。浏览器跟随 `303 /` 后由现有根路由调用 `ensureRuntime(user.id)`，这样 token 失败不会创建 Runtime 或用户目录。

成功响应必须包含 `Cache-Control: no-store`、`Pragma: no-cache` 和 `Referrer-Policy: no-referrer`。失败响应也使用 `no-store`。

-----

## 管理员入口保留

管理员登录从普通用户登录中拆分，但继续使用现有本地账号、Argon2id 密码、失败限速和审计。

### 路由

```text
GET  /admin/login
POST /admin/auth/login
POST /admin/auth/logout
GET  /admin
```

`POST /admin/auth/login` 必须在执行 Argon2id 校验前要求数据库用户满足：

```text
auth_source = local
role = admin
enabled = true
```

错误统一返回 `invalid credentials`，不能泄露用户名是否存在、角色是否错误或账号是否禁用。

### 独立 Cookie

使用两个不同 Cookie：

```text
普通用户：dsh_multiuser_session
管理员：  dsh_multiuser_admin_session
```

生产属性均为 `HttpOnly; Secure; SameSite=Lax; Path=/`。普通页面和 `/api` 只读取普通 Cookie；`/admin` 及其 API 只读取管理员 Cookie。普通 SSO 登录不得覆盖或撤销管理员 Cookie，管理员登录不得覆盖普通 Cookie。

路由授权：

- `/` 和普通静态代理使用普通 Session；没有普通 Session 时显示“请从 IdP 进入”页面。
- `/api/*` 和 `/api/remote.mux` 只接受普通 Session。
- `/admin/login` 对未登录管理员开放。
- `/admin/*` 只接受管理员 Session。
- 管理员 Cookie 不得用于普通 Runtime 代理。
- 普通 Cookie 不得用于管理员 API。

现有 `/auth/login` 可以在一个发布周期返回 `404` 或 `410`，但不能继续允许本地普通用户登录。`/auth/logout` 只注销普通 Cookie；管理员注销使用 `/admin/auth/logout`。

### 管理员页面

修改 `src/admin-page.ts`：

- 管理员页面未认证时跳转 `/admin/login`。
- 管理员页面注销按钮调用 `/admin/auth/logout`。
- 不在普通登录提示页显示管理员入口链接。

保留 `init-admin`、管理员密码重置和当前管理员审计功能。生产反向代理应额外对 `/admin/login` 和 `/admin/*` 配置办公网、VPN 或 IP allowlist。

-----

## CLI 和配置

### `src/gateway-cli.ts`

当前参数：

```text
--sso-public-key <entry...>        each entry uses kid=/absolute/key.pem
--sso-issuer <issuer>
--sso-audience <audience>
--sso-origin <origin>
--sso-session-minutes <minutes>   default 60
```

配置不变量：

- 只要出现任一 SSO 参数，就必须提供完整 SSO 参数集合。
- `--sso-origin` 必须是 HTTP(S) origin，不能包含 path、query、fragment 或凭据；生产外部 TLS 由 Ingress 负责。
- 每个公钥参数必须包含唯一 `kid` 和可读文件路径。
- Session 分钟必须是有限正整数并受合理上限约束。
- 配置错误在监听端口前失败。

### `src/cli.ts`

修改本地账号命令：

- `init-admin` 保持不变，但明确创建 `auth_source=local` 管理员。
- 删除或隐藏普通 `create-user` 的生产指导；如果保留命令，只允许显式迁移/测试用途。
- `reset-password` 只允许 `auth_source=local`。
- `link-sso-user` 用于按数据库模型显式绑定已有普通用户。

### 部署文件

修改 `deploy/gateway.env.example` 和 `deploy/dsh-multiuser.service`，加入公钥路径、issuer、audience、IdP origin 和 SSO Session TTL。公钥可以部署到 `/etc/dsh-multiuser/keys/`，权限允许 Gateway 服务账号读取；私钥永远不部署到 Gateway 主机。

生产拓扑要求：

- 单机部署时 Gateway 监听 `127.0.0.1`；Kubernetes Pod 中监听 `0.0.0.0`，只由 Service 和 Ingress 暴露。
- 用户 Runtime 继续只监听回环动态端口。
- Gateway 的浏览器地址应与 IdP 域名分离，避免接收 IdP 已有的 Domain Cookie。
- 反向代理访问日志不得记录 POST body 或 Cookie。
- `/auth/sso` 请求体上限同时在代理和 Gateway 设置为 8 KiB。

-----

## 验证覆盖范围

### `test/sso.test.ts`

使用测试 Ed25519 密钥覆盖：

- 正确 token 验证并返回规范化 `OpsIdentity`。
- 错误签名、错误 `kid`、算法、issuer、audience 全部拒绝。
- 缺少或错误类型 claims 全部拒绝。
- `sub`、`jti` 不是 UUID 时拒绝。
- token 超过 60 秒生命周期、已过期、尚未生效或超出时钟偏差时拒绝。
- 出现 `role`、`admin` 或 `permissions` claims 时拒绝。
- 相同 `jti` 只能消费一次，过期记录可清理。
- 错误消息和日志不包含完整 token 或 claims。

### `test/auth-local.test.ts`

覆盖：

- 版本 1 数据库迁移到版本 2 后保留所有用户、Session、Runtime 和审计记录。
- 外部用户首次创建后固定为 `role=user`。
- 同一 issuer/subject 重复登录复用内部 UUID。
- 用户名和显示名变化只更新显示字段，不改变 UUID。
- 相同 username、不同 subject 不会合并。
- 并发首次创建只产生一名用户。
- 禁用外部用户后 SSO 不会自动启用。
- 本地管理员不能绑定外部 subject。
- 外部用户不能通过管理员密码认证方法登录。
- 高于支持版本的数据库拒绝打开。

### `test/gateway.test.ts`

覆盖：

- 可信 IdP Origin 的有效表单返回 `303 /` 和普通 Cookie。
- 错误/缺失 Origin、错误 Host、JSON body、额外字段、超大 body 拒绝。
- token 失败时不创建用户、Session、Runtime 记录或目录。
- SSO 用户即使用户名为 `admin` 仍是普通用户。
- 同一 JWT 第二次提交拒绝。
- 普通 Cookie 不能访问 `/admin`，管理员 Cookie 不能访问 `/api` 或 WebSocket。
- 同一浏览器同时携带两种 Cookie 时，普通根页面和管理员页面分别工作。
- 本地普通账号不能从管理员入口登录。
- 本地管理员登录、注销、失败限速和审计继续工作。

### CLI 测试

显式账号绑定测试覆盖：

- 普通本地用户可以绑定一次外部 subject。
- 管理员、已绑定用户、重复 subject 和不存在用户拒绝。
- 成功绑定撤销旧 Session但保留内部 UUID 和 Runtime 数据记录。

### 真实 Harness 集成测试

现有 fake Runtime 测试不能证明最新版 Harness 兼容。合并前必须使用真实 `dsh --profile user-runtime` 覆盖：

1. 两个不同 SSO subject 启动两个独立 Runtime。
2. 两边完成 Runtime launch token 和 `dsh-auth-*` Cookie 交换。
3. 页面、`/api` RPC、`/api/remote.mux`、附件和导出正常。
4. A 无法读取 B 的 Session、workspace、设置、凭据和事件。
5. 同一 subject 重登及 Runtime idle reap 后仍读取原数据。
6. 本地管理员可查看允许的只读信息，但不能执行 prompt 或使用普通 Runtime API。

### 必跑检查

实现完成后执行并只报告实际运行的命令：

```sh
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

真实 Harness 集成测试需要作为独立命令或 Vitest integration target 加入仓库；缺少 API key 时，认证、Runtime 启动、RPC list 和隔离部分仍应可运行，只有模型请求用例可以跳过。

-----

## 维护与发布验证

维护者发布新版本时，使用 [发布验收](open-source-release/04-release-validation.md) 记录实际执行的单元、集成、打包和安全检查。涉及数据库 Schema 或认证配置的部署，必须先停止服务并执行一致性备份，再按 [生产部署](open-source-release/03-production-deployment.md#升级与回滚) 的安装、启动和验证顺序操作。

DSH 兼容性由 [compatibility.json](../compatibility.json) 和真实 Runtime 集成测试共同定义。新增 DSH 版本前，先在临时 home 中验证 Profile、Runtime Cookie、HTTP RPC、Remote WebSocket 和双用户隔离；未验证的版本不得加入支持列表。

## 验收标准

以下条件描述当前认证实现必须持续满足的行为：

- Gateway 仅接受 EdDSA、已配置 `kid`、固定 issuer/audience 和不超过 60 秒的 token。
- 相同 token 在同一 Gateway 进程中只能交换一次。
- 外部身份只按 issuer/subject 映射，用户名变化不改变内部 UUID。
- IdP SSO 用户只能获得普通用户角色。
- 本地管理员入口、密码、Cookie 和管理路由保持可用，并与普通 Session 隔离。
- 普通 Cookie不能访问管理员接口，管理员 Cookie不能访问普通 Runtime API。
- 无效 token 不产生用户、Session、Runtime 记录或目录。
- 两名真实 SSO 用户的数据、WebSocket、附件、设置和凭据隔离。
- Runtime 内部 `dsh-auth-*` Cookie 继续由 Gateway 管理，既不返回浏览器也不写日志。
- 现有数据库原地迁移后用户数据可读，回滚备份可恢复。

## 上线和回滚

上线前停止 Gateway 和所有 Runtime，备份：

```text
data/gateway.sqlite
data/gateway.sqlite-wal
data/gateway.sqlite-shm
data/users/
```

记录插件提交号、DeepSeek Harness 提交号、`pnpm-lock.yaml` 和数据库 `PRAGMA user_version`。先在数据库副本上执行迁移并验证管理员登录、用户列表和已有 Runtime 记录。

上线顺序：部署接受公钥和 SSO 路由的 Gateway，验证本地管理员登录，再部署 IdP Server 签发接口，最后开放 IdP 菜单。先灰度一个角色和两个测试用户。

回滚时先关闭 IdP 菜单和签发接口，再停止 Gateway 和所有 Runtime，恢复旧 app、SQLite 及其 WAL/SHM 和 `data/users/` 的一致备份。版本 1 代码不能打开已经迁移的版本 2 数据库，因此禁止只回滚代码不恢复数据库。

密钥轮换时先配置新旧两个 `kid` 公钥，再切换 IdP 私钥；等待旧 token 的 60 秒生命周期结束后移除旧公钥。

## 禁止事项

- 禁止信任浏览器提交的 username、name、role、user ID 或身份 header。
- 禁止按用户名、姓名、目录名或 JWT `jti` 选择 Runtime。
- 禁止接受 HMAC、`alg=none` 或 token 自带算法。
- 禁止让 SSO claims 创建、绑定或提升管理员。
- 禁止把 IdP `sessionID`、JWT、Gateway Cookie 或 Runtime Cookie写入日志和审计。
- 禁止为 SSO 放宽全部 Gateway Origin 或启用 `Access-Control-Allow-Origin: *`。
- 禁止自动把现有同名本地用户与 SSO 用户合并。
- 禁止在无数据库和用户目录一致备份时迁移或回滚。
- 禁止用 fake Runtime 测试替代真实 Harness 隔离验证。

## Dev Note

本文是当前协议参考，不是迁移脚本或在线升级指南。生产升级不调用已禁用的 `upgrade` 命令，统一执行停止服务、`backup`、新版本 `install`、启动服务和验证。
