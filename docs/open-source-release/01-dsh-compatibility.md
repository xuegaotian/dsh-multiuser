# DSH 兼容升级

状态：已实施（2026-09-15，DSH `0.1.5-rc.1` 主验证 + `0.1.6-alpha.1` 前瞻验证）  
目标：建立可重复的 DSH 版本兼容策略，并对真实 Runtime 链路进行验收。

实施结果：

- 真实 DSH Runtime 集成测试已落地：`test/harness-latest.integration.test.ts`（Runtime 直连：token 交换、Cookie 认证、RPC envelope、WebSocket、双用户隔离）与 `test/gateway-runtime.integration.test.ts`（完整 Gateway 链路：SSO 登录 → 用户 Runtime 启动 → HTTP/RPC/WebSocket 代理）。
- CI 矩阵已落地：`.github/workflows/ci.yml` 提供 `unit`（阻断）、`integration-latest`（阻断，动态解析 npm `latest`）、`integration-alpha`（不阻断，动态解析 npm `alpha`）。
- `compatibility.json` 已生成并只记录实测版本。
- 集成测试通过 `DSH_INTEGRATION_BIN` 选择被测 DSH，未设置时自动跳过；所有测试 home 均在临时目录。

## 当前基线

截至 2026-09-15：

| 项目 | 版本 | 意义 |
| --- | --- | --- |
| 本地已验证 Harness checkout | `0.1.2-alpha.1` | 当前项目代码主要基线 |
| npm `latest` | `0.1.5-rc.1` | 首次开源发布必须通过的用户默认版本 |
| npm `next` | `0.1.5-rc.2` | 可选支持版本 |
| npm `alpha` 与最新 Git 标签 | `0.1.6-alpha.1` | 前瞻兼容信号，首发时可允许失败 |

每次开始升级前重新查询，不复制上表作为当前事实：

```sh
npm view @deepseek-ai/dsh dist-tags --json
npm view @deepseek-ai/dsh versions --json
```

## 支持策略

首个公开版本采用两层矩阵：

- **必须通过**：npm `latest` 指向的精确 DSH 版本。
- **允许失败**：npm `alpha` 指向的精确 DSH 版本，用于提前发现变化。

不建议首发就宣称一个宽范围，例如 `>=0.1.2`。DSH 仍在预发布阶段，Web 认证、Remote 传输、Profile 和 RPC 方法都可能变化。

## 第一阶段：创建独立兼容环境

不要在已有用户数据或日常 DSH checkout 上直接升级。为每个候选版本创建新目录：

```sh
mkdir -p ./compat-work
cd ./compat-work
npm init -y
npm install --save-exact @deepseek-ai/dsh@0.1.5-rc.1
npx dsh --version
```

成功信号：

- `npm install` 退出码为 0。
- `npx dsh --version` 输出与锁定版本一致。
- 测试目录不使用维护者的默认 `DSH_HOME`。

为测试命令显式设置专用 home：

```sh
export DSH_COMPAT_HOME="$PWD/dsh-home"
DSH_HOME="$DSH_COMPAT_HOME" npx dsh --profile web --dump-config > effective-config.txt
```

## 第二阶段：检查八个集成点

升级不能只看 TypeScript 编译。逐项核对以下集成点，并在 PR 或验收记录中保留 DSH 版本和观测结果。

### 1. 公开 CLI 入口

目标状态是调用已安装的 `dsh` 命令，不把 `apps/cli/lib/bin.js` 这种仓库内部路径作为唯一生产入口。

验收：

```sh
command -v dsh
dsh --version
dsh --profile web --help
```

如果 Gateway 仍依赖 `--launcher-entry`，先增加使用 npm 发布 CLI 的测试，再移除生产文档中的 checkout 路径。

### 2. Profile 与 Bundle 解析

验证 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 和本项目 Runtime Bundle 按预期顺序出现：

```sh
DSH_HOME="$DSH_COMPAT_HOME" dsh plugin --profile user-runtime add /path/to/packed-runtime-bundle.tgz
DSH_HOME="$DSH_COMPAT_HOME" dsh --profile user-runtime --dump-config > user-runtime-config.txt
rg -n "dsh-base|dsh-web-app|user-runtime|webserver|connection" user-runtime-config.txt
```

不能只检查字符串存在；还要确认 `web-runtime`、`webserver`、`connection`、`skill-filesystem`、`tool-skill` 和 `llm-pi-ai` 的最终配置值。

### 3. Runtime 启动命令

验证 Gateway 启动的是带显式 `DSH_HOME`、workspace、回环地址和动态端口的原版 DSH。保留子进程完整 argv，但不记录任何凭据值。

成功信号：Runtime 进程运行目录为该用户 workspace，端口只监听 `127.0.0.1`，两名用户的 `DSH_HOME` 不同。

### 4. 启动 token 和 Runtime Cookie 交换

验证 Runtime 打印的 `/?token=...` URL、`303 /` 跳转和 `dsh-auth-*` Cookie。不得在日志或测试快照中保留 token 和 Cookie 值。

成功信号：Gateway 获得的 Cookie 能完成一次已认证 Runtime API 请求；不带 Cookie 的相同请求被拒绝。

### 5. HTTP 和 WebSocket 传输

当前 Gateway 显式代理 `/api/remote.mux`。在目标 DSH 版本上用真实浏览器网络记录确认实际 WebSocket 路径，再更新代理和测试。

必测行为：

- 打开已有会话。
- 新建会话并收到模型流式输出。
- 调用工具并渲染工具结果。
- 中断生成。
- 断开 WebSocket 后重连。
- Gateway 重启后重新连接原有会话。

### 6. 管理员会话 RPC

逐个验证管理员使用的方法：

- `session/list`
- `session/search`
- `session/page`
- `subagent/list`
- `subagent/history`

对每个方法保留请求字段和非敏感响应字段的 fixture。方法名仍存在不代表 payload 仍兼容。

### 7. Skill、MCP 和模型提供方

验证以下跨版本行为：

- `DSH_AGENTS_HOME` 下的公共 Skill 可被发现。
- 用户私有 Skill 在同名冲突时的优先级与文档一致。
- `@deepseek-ai/dsh-mcp-client` 仍接受生成的 stdio 和 Streamable HTTP 配置。
- `llm-pi-ai` 接受公共 provider 配置，API key 不出现在管理 API 和审计日志中。

### 8. Profile 合并与持久化

为同一用户执行以下序列：

1. 启动 Runtime，创建会话和文件。
2. 安装一个用户私有插件、Skill 和 MCP。
3. 管理员增加一项公共资源。
4. 重启 Runtime，确认公共和私有资源都存在。
5. 管理员删除该公共资源。
6. 再次重启，确认公共资源已删除，私有资源仍存在。
7. 升级 DSH，确认会话和 workspace 可继续使用。

## 第三阶段：自动化测试矩阵

在 CI 中增加三类作业：

| 作业 | DSH 来源 | 是否阻断发布 |
| --- | --- | --- |
| `unit` | 无真实 DSH | 是 |
| `integration-latest` | npm `latest` 解析出的精确版本 | 是 |
| `integration-alpha` | npm `alpha` 解析出的精确版本 | 否，但失败必须创建或更新兼容 Issue |

CI 在日志开头打印 Node、pnpm、DSH 和本项目版本。测试不读取维护者的默认 home，不使用真实模型密钥完成基础传输验收。可以用可控 mock LLM provider 验证流式事件。

## 第四阶段：记录兼容结果

在仓库根目录添加机器可读的 `compatibility.json`，由 CI 和 README 共同使用：

```json
{
  "testedDshVersions": ["0.1.5-rc.1"],
  "canaryDshVersions": ["0.1.6-alpha.1"],
  "node": "^22.19.0 || >=24.0.0"
}
```

发布时把实际验证版本写入该文件，不将动态 dist-tag 写进发布产物。

## 完成标准

- [x] npm `latest` 版本的真实 Runtime、HTTP、WebSocket、认证和 Profile 合并测试全部通过（`0.1.5-rc.1`，`pnpm test:integration` 11/11 通过）。
- [x] 两名用户的验收证明会话、Runtime Cookie 和端口互不可见（`test/harness-latest.integration.test.ts` 的 two-user isolation 用例；完整浏览器隔离验收属于手册第 4 章发布验收范围）。
- [x] README 和 `compatibility.json` 仅声明已实测版本（`0.1.5-rc.1` 与前瞻验证的 `0.1.6-alpha.1`）。
- [x] alpha（`0.1.6-alpha.1`）当前通过全部集成测试，无需创建兼容 Issue；CI 的 `integration-alpha` 作业会在未来 alpha 破坏兼容时以非阻断方式暴露失败。

