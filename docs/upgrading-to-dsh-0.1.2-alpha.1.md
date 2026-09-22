# dsh-multiuser 适配 DeepSeek Harness 0.1.2-alpha.1

> **历史资料，不是当前支持流程。** 本文记录 DSH `0.1.2-alpha.1` 的适配过程；当前支持版本、验证方式和生产升级步骤分别以 [DSH 兼容升级](open-source-release/01-dsh-compatibility.md) 和 [生产部署](open-source-release/03-production-deployment.md) 为准。本文命令不可直接用于当前版本升级。

## 1. 基线和结论

本文档对应 DeepSeek Harness 提交 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，版本为 `0.1.2-alpha.1`。

当前多用户架构仍然保留：Gateway 负责登录、权限和路由；每个用户拥有独立 DSH Runtime、`DSH_HOME`、workspace、会话目录和 loopback 端口。

需要重做的是 Web/API 适配层。旧版 `packages/host/apiproxy` 已删除，最新版改用 `client-connection`、`api-gateway`、session/settings/workspace controller 和统一 Remote Stream。

## 2. 修改范围

重点文件：

- `src/gateway.ts`：认证 Cookie、HTTP API、Remote WebSocket 代理
- `src/runtime-manager.ts`：Runtime 生命周期和内部认证状态
- `src/runtime-launcher.ts`：启动输出和 token 捕获
- `src/profile-install.ts`：Profile 安装与校验
- `src/user-profile.ts`：用户 Profile 初始化与版本检查
- `packages/bundle/user-runtime/cordis.patch.yml`：新版 Bundle 配置
- `profiles/user-runtime/package.json`：Profile 依赖

测试文件：

- `test/gateway.test.ts`
- `test/runtime-manager.test.ts`
- `test/profile-install.test.ts`
- 新增 `test/harness-latest.integration.test.ts`

## 3. 第一阶段：单独验证新版 Runtime

先不经过 Gateway，使用临时 `DSH_HOME` 启动：

```sh
node /path/to/deepseek-harness/apps/cli/lib/bin.js \
  --profile user-runtime \
  --no-open \
  --port <临时端口>
```

确认 `dsh-base`、`dsh-web-app` 和多用户 Bundle 都能加载，`webserver` 绑定 `127.0.0.1`，`connection`、`api-gateway` 及各 controller 正常激活。

同时执行 `--dump-config`，但不能把它当作实际启动测试的替代品。需要确认 Runtime 能正常退出，不留下残留进程。

重新检查 `packages/bundle/user-runtime/cordis.patch.yml` 对以下行的覆盖是否仍然有效：

- `web-runtime`
- `webserver`
- `connection`
- `skill-filesystem`
- `tool-skill`

## 4. 第二阶段：实现 Runtime 浏览器认证

### 4.1 新版认证流程

最新版 `client-connection` 的流程是：

1. Runtime 生成一次性启动 token。
2. 初次入口使用 `/?token=<token>`。
3. Runtime 校验 token 后设置按 authority 绑定的 `dsh-auth-*` Cookie。
4. 后续 `/api` 和 Remote WebSocket 请求必须携带该 Cookie。

`dsh_multiuser_session` 只能证明用户通过了多用户 Gateway 登录，不能代替 Runtime Cookie。

### 4.2 Gateway 改动

在 `src/gateway.ts`、`src/runtime-launcher.ts` 和 `src/runtime-manager.ts` 中实现：

1. 用户首次访问 `/` 时确保对应 Runtime 已启动。
2. 捕获该 Runtime 的 token 或认证 URL。
3. Gateway 访问 Runtime 的 token URL，接收重定向和 `Set-Cookie`。
4. 保存该用户专属的 Runtime Cookie。
5. 后续代理请求同时携带多用户登录 Cookie 和 Runtime Cookie。
6. Runtime 重启后清除旧 Cookie 并重新握手。

建议增加内部状态：

```text
RuntimeAuthState
  |- launchToken
  |- cookieName
  |- cookieValue
  |- authority
  `- expiresAt
```

token 和 Runtime Cookie 不能出现在管理员 API、普通 API、日志或审计日志中。不同用户不得共享认证状态。

## 5. 第三阶段：迁移 Remote WebSocket

旧版本路径：

```text
/api/events.mux
/api/events.host
```

最新版统一使用：

```text
/api/remote.mux
```

修改 `src/gateway.ts` 的 `handleUpgrade`：

1. 只接受 `/api/remote.mux`。
2. 验证多用户 Cookie、用户启用状态和 Runtime 归属。
3. 上游 WebSocket 请求携带 Runtime Cookie。
4. 浏览器和 Runtime 之间双向转发文本帧和二进制帧。
5. 任一端关闭或出错时关闭另一端。
6. 连接期间维护 `browser` 活跃计数，避免 idle reap 停止 Runtime。

必须验证页面连接、新建会话、prompt 增量输出、approval、ask-user-question、刷新重连、Runtime 重启恢复，以及 A/B 用户之间的 WebSocket 隔离。

## 6. 第四阶段：重新验证 `/api` RPC

最新版仍使用 `/api`，但 API 不再由旧 `host/apiproxy` 实现。必须重新验证：

```text
session.list       session.search       session.create
session.history    session.models       session.selectModel
session.prompt     session.rename       session.fork
session.cancel     session.attachment   session.export
subagent.list      subagent.history
settings.*         workspace.*         credentials.*
```

代理规则：

- 先验证多用户登录 Cookie，再由 Runtime 验证 `dsh-auth-*` Cookie。
- POST 保持完整 RPC envelope，不在 Gateway 重写 payload。
- GET/HEAD 的 session export 保留响应头和响应体。
- 用户传入的 `userId` 不能决定 Runtime；Runtime 必须由已认证用户 ID 映射得到。
- 保留请求体限制、上游断开处理和错误状态转换。

管理员仍然只能通过独立只读路由读取指定用户：

```text
/admin/sessions/<userId>/list
/admin/sessions/<userId>/search
/admin/sessions/<userId>/history
```

管理员禁止执行 prompt、cancel、fork、rename、Shell、Terminal、文件写入和凭据写入。读取操作记录 actor、目标用户、目标会话、方法和请求 ID。

## 7. 第五阶段：检查 Profile 安装器

检查 `src/profile-install.ts`、`src/public-profile.ts` 和 `src/user-profile.ts`，确认新版仍支持：

```text
dsh plugin --profile <profile> add <package>
dsh plugin --profile <profile> install
dsh --profile <profile> --dump-config
```

安装逻辑继续调用 Harness 原生命令，不要复制 Bundle 或 pnpm 解析逻辑。验证 Bundle 写入、依赖安装、安装失败恢复和必需 Bundle 保护。

Profile 更新不能覆盖用户的 `settings.yaml`、`.credentials.yaml`、sessions、workspace 和日志。

## 8. 第六阶段：数据兼容

升级前停止 Gateway 和所有 Runtime，备份：

```text
data/gateway.sqlite
data/gateway.sqlite-wal
data/gateway.sqlite-shm
data/users/<user-id>/dsh-home
data/users/<user-id>/workspace
data/users/<user-id>/logs
```

`gateway.sqlite` 由多用户项目维护，不应随 Harness 升级重建。当前 Profile 使用 JSONL 会话持久化，旧会话必须在副本上实际测试：列表、历史、继续对话、导出和附件。失败时保留旧目录，不自动删除或重写。

## 9. 第七阶段：测试

现有单元测试继续覆盖账号、路由、Runtime 生命周期和权限。新增真实 Harness 集成测试，使用临时目录、临时端口和：

```text
/path/to/deepseek-harness/apps/cli/lib/bin.js
```

至少覆盖：

- Runtime 启停、token exchange 和 Cookie 认证。
- 登录、会话创建、prompt、增量输出、取消和重连。
- `/api/remote.mux` 的建立、断开和恢复。
- 用户 A/B 的会话、workspace、settings、credentials、附件和事件隔离。
- history、search、fork、export、approval 和用户问题。
- 管理员只读查询，以及管理员不能执行 prompt。
- idle reap 后再次访问能够恢复 Runtime。

## 10. 实施顺序和验收

按顺序执行：

1. 单独启动最新版 Runtime。
2. 修复 Profile 和 Bundle 加载。
3. 实现 Runtime token/Cookie 状态。
4. 实现 Gateway 认证握手代理。
5. 迁移 `/api/remote.mux`。
6. 验证普通用户完整流程和双用户隔离。
7. 验证管理员只读流程。
8. 验证旧用户数据。
9. 增加真实集成测试并更新部署文档。

完成标准：Harness 和 `dsh-multiuser` 均能构建；`/api` 和 `/api/remote.mux` 通过双层认证；用户数据、文件、凭据、设置和事件互不可见；Runtime 重启和 WebSocket 重连可恢复；管理员权限保持只读。

## 11. 回滚

升级前记录旧 Harness 提交号、多用户插件提交号和 `pnpm-lock.yaml`。失败时停止所有进程，恢复旧版 Harness、Profile、用户目录和 `gateway.sqlite`，再验证登录和会话读取。

禁止在未备份时修改会话文件；禁止继续依赖已删除的 `packages/host/apiproxy`；禁止只修改 WebSocket 路径而忽略 Runtime Cookie；禁止依据用户提交的 `userId`、`sessionId` 或 workspace 路径授权。
