# 从当前工作区到正式发布

状态：执行中  
对象：首次公开 `dsh-multiuser` 仓库并发布 npm 包的维护者  
目标：用可复核的顺序完成 GitHub 首次推送、预发布验证和正式 `v0.1.0` 发布。

## Summary

仓库身份已经确定为 GitHub `xuegaotian/dsh-multiuser` 和 npm `dsh-multiuser`。首次推送前的代码整改已经完成：CI 会实际执行 tarball 测试，Node/pnpm 版本已统一，`install` 具备失败回滚，预览版 `upgrade` 已禁用，生产升级统一为“停止服务 → `backup` → `install` → 启动 → 验证”。完成候选提交复核后可以推送 GitHub；Linux、systemd、HTTPS、真实 IdP 和双浏览器隔离尚未完成验收，因此不能直接发布 npm 正式版或宣称 production-ready。

推荐发布节奏：先修复首次公开仓库必须解决的问题，再推送 `main`；CI 全绿后发布 `0.1.0-alpha.1`；生产部署和隔离验收通过后再发布 `0.1.0`。

## Table of Contents

- [当前结论](#当前结论)
- [阶段一：首次推送前](#阶段一首次推送前)
- [阶段二：首次推送 GitHub](#阶段二首次推送-github)
- [阶段三：推送后配置 GitHub](#阶段三推送后配置-github)
- [阶段四：发布 npm 预览版](#阶段四发布-npm-预览版)
- [阶段五：正式 v0.1.0 验收](#阶段五正式-v010-验收)
- [最终放行表](#最终放行表)
- [Dev Note](#dev-note)

-----

## 当前结论

下面的三种操作有不同的放行条件。

| 操作 | 当前结论 | 放行条件 |
| --- | --- | --- |
| 推送到私有仓库或非默认分支 | 可以 | 提交内容中没有密钥和运行数据 |
| 首次推送到公开仓库的 `main` | 待最终复核后可以 | 重新执行候选提交检查，审查暂存内容并提交 |
| 发布 npm `0.1.0` 正式版 | 不可以 | 阶段一至阶段五全部完成 |

已经确认的事实：

- GitHub owner 是 `xuegaotian`，仓库地址写入了 [`package.json`](../../package.json) 和 [`SECURITY.md`](../../SECURITY.md)。
- npm 包名是无 scope 的 `dsh-multiuser`；2026-09-17 查询 registry 返回 `404`，表示当时没有同名公开包。发布前必须再次查询，因为无 scope 名称可能被其他账号抢先注册。
- `package.json`、README 和部署文档使用相同的包名。
- 本地工作区没有配置 Git remote，当前分支为 `fix/review-2026-09-16`。
- 当前发布功能分散在已修改文件和未跟踪文件中；GitHub 只能看到提交后的内容。
- 已有本地证据包括 TypeScript 构建、普通测试、DSH `0.1.5-rc.1` 真实集成测试和 tarball 安装测试。2026-09-17 最终验证实测：`pnpm install --frozen-lockfile` 无变更、`pnpm typecheck` 与 `pnpm build` 退出码 0、`pnpm test` 126 passed / 15 skipped（14 个测试文件通过、3 个集成文件跳过；15 个 skip 逐项为 `harness-latest` 7 个、`gateway-runtime` 4 个、`install-pack` 3 个共 14 个缺 `DSH_INTEGRATION_BIN`/`DSH_PACK_DIR` 的集成用例，加 1 个 dotted-loopback 主机名在本机不解析的用例。注入环境变量后同一批集成用例为 11/11 与 3/3 通过）、`pnpm audit --prod` 无漏洞、生产依赖 7 个全部为 MIT、`git diff --check` 通过、tarball 为 34 个文件且不含敏感内容。首次推送前仍须从最终候选提交重新执行这些检查。

-----

## 阶段一：首次推送前

阶段一只处理会造成公开仓库误导、CI 假通过、数据风险或授权风险的问题。完成这些项目后才推送公开 `main`。

### 1. 确认代码授权

确认你有权用 MIT 发布全部源代码、文档和资源。代码如果属于职务作品、客户项目或包含雇主资产，应先获得权利人的书面许可。

完成条件：

- `LICENSE` 的版权主体与你确认的权属一致。
- 仓库中没有客户名称、内部域名、生产地址、账号、密钥、真实 JWT、Cookie、数据库和用户会话。
- 引入或改写的第三方代码保留了许可证要求的声明。

### 2. 修复 CI 的 tarball 静默跳过（已完成）

[`test/install-pack.integration.test.ts`](../../test/install-pack.integration.test.ts) 同时要求 `DSH_INTEGRATION_BIN` 和 `DSH_PACK_DIR`。[CI 工作流](../../.github/workflows/ci.yml) 已传入两者，并在缺少发布测试前置条件时失败，不再把跳过当作成功。

已完成：

1. 在 `pack-verify` 的测试步骤传入 `DSH_PACK_DIR="$PACK_DIR"`。
2. 由 `pack-verify` 在运行测试前显式校验前置条件：`test -n "${PACK_DIR:-}"`、`test -d "$PACK_DIR"`、`test -x "$DSH_INTEGRATION_BIN"`，任一不满足即 `::error::` 并以非 0 退出，因此缺少发布前置条件时不会静默通过。
3. 在 CI 日志中检查结果必须是 `3 passed`，不能是 `3 skipped`。

注意：`test/install-pack.integration.test.ts` 自身在缺少 `DSH_INTEGRATION_BIN` / `DSH_PACK_DIR` 时执行 `describe.skip`，这是必要的——`unit` 作业用 `pnpm test` 跑全量套件但没有这两个变量。阻断责任由第 2 条的作业级前置校验承担，不要改成让测试文件在 `CI=true` 时直接失败，否则 `unit` 作业会被这些集成用例拖红。

完成条件：GitHub Actions 的 `pack-verify` 从 tarball 安装 CLI，运行 `--help` 和 `doctor`，最后显示 tarball 测试 3/3 通过。

### 3. 补齐 Node 和 pnpm CI 矩阵（已完成）

包声明支持 Node `^22.19.0 || >=24.0.0`，CI 已覆盖最低版本和 Node 24。

建议矩阵：

```yaml
node-version: ['22.19.0', '24']
```

仓库和 GitHub Actions 已统一使用 `pnpm@11.23.0`，`package.json` 通过精确的 `packageManager` 字段固定版本。

完成条件：最低 Node 22、Node 24、真实 DSH latest、alpha canary 和 pack-verify 作业的版本都在日志中明确显示。

### 4. 修正安装和升级的高风险语义（已完成）

首次公开前要求的两项均已处理。

#### install 的回滚范围

`install` 现在执行真实 `doctor`，并把旧应用目录保留到启动入口、systemd 文件和后置验证全部成功；后置步骤失败时恢复旧应用目录。

处理方式：

1. 在删除旧目录之前完成所有可在 staging 中完成的验证。
2. 应用、启动入口和 systemd 文件全部成功后再删除 `.previous`。
3. 安装结束时执行真实 `doctor`；失败时恢复上一应用目录，并保留失败日志。
4. 增加“替换后步骤失败会恢复旧应用”的测试。

#### upgrade 的一致性备份

预览版 `upgrade` 现在是明确禁用的入口，不执行复制、备份或安装写操作。生产升级只支持“停止服务 → `backup` → `install` → 启动 → 验证”。

首个预览版采用以下最小方案：

- CLI 保留 `upgrade` 名称用于明确报错和指向受支持流程，但不提供在线升级能力。
- README、安装打包文档和生产部署文档统一使用停止、备份、安装、启动和验证流程。

完成条件：README、CLI 帮助、生产手册和实际行为描述同一条升级路径。

### 5. 清理公开文档的状态冲突（已完成）

已完成：

- 把 [SSO 集成方案](../sso-integration.md) 从 `proposed` 计划改成当前 SSO 协议与 IdP 接入参考，删除已经完成的“待实施”叙述。
- 明确 [DSH 0.1.2 迁移文档](../upgrading-to-dsh-0.1.2-alpha.1.md) 是历史迁移记录，或者将仍有效内容并入当前兼容文档后删除该文件。
- 更新发布手册首页中已经过期的缺口，例如 health/readiness 和发布字段已经实现，不能继续描述为完全缺失。
- 增加 `.github/ISSUE_TEMPLATE/`、Pull Request 模板和 `CHANGELOG.md`。
- 根据生产依赖的许可证核对结果增加 `THIRD_PARTY_NOTICES.md`，或在发布证据中说明为什么不需要额外 notice。

完成条件：新用户不会同时读到“SSO 已实现”和“SSO 待实施”，也不会把旧 DSH 迁移计划当成当前安装说明。

### 6. 扫描准备公开的全部内容

下面的检查必须覆盖已跟踪文件和准备加入 Git 的未跟踪文件。

```sh
git status --short
git diff --check
git diff --stat
git ls-files --others --exclude-standard
rg -n '/Users/|/home/|example\.internal|TODO|FIXME' README.md SECURITY.md CONTRIBUTING.md package.json docs deploy src test .github
```

安装并运行一个能扫描 Git 历史和当前工作区的密钥扫描器，例如 Gitleaks。普通字符串搜索不能替代密钥扫描。

完成条件：扫描报告没有真实 Secret；测试 fixture 中的假值有明确名称，不会被误认为真实凭据。

### 7. 执行候选提交检查

先确认被测 DSH 版本：

```sh
npm view @deepseek-ai/dsh dist-tags --json
npm view dsh-multiuser name version
```

`dsh-multiuser` 查询应返回 `404`。然后执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod
pnpm licenses list --prod
git diff --check
```

创建隔离的 DSH 安装并执行真实测试：

```sh
mkdir -p compat-work
npm install --prefix compat-work --save-exact @deepseek-ai/dsh@0.1.5-rc.2
DSH_INTEGRATION_BIN="$PWD/compat-work/node_modules/.bin/dsh" \
DSH_INTEGRATION_VERSION="0.1.5-rc.2" \
  pnpm test:integration
```

从真实 tarball 验证安装路径：

```sh
RELEASE_PACK_DIR=$(mktemp -d)
pnpm pack --pack-destination "$RELEASE_PACK_DIR"
DSH_PACK_DIR="$RELEASE_PACK_DIR" \
DSH_INTEGRATION_BIN="$PWD/compat-work/node_modules/.bin/dsh" \
DSH_INTEGRATION_VERSION="0.1.5-rc.2" \
  pnpm vitest run test/install-pack.integration.test.ts
npm pack --dry-run
```

完成条件：

- 类型检查和构建退出码为 `0`。
- 普通测试没有失败。
- 真实 DSH 测试是 11/11 通过。
- tarball 测试是 3/3 通过，不能跳过。
- `npm audit --prod` 没有未处理的可达漏洞。
- tarball 不含 `.env`、SQLite、日志、PEM、私钥、TypeScript 源码、source map 或本机绝对路径。

### 8. 安全扫描快照与工作区差异（需在下一次扫描覆盖）

2026-09-17 的 Codex Security 扫描（scan ID `505f84d8-a9a9-492a-a382-7b97f148ecd6`）已在 `2026-09-17T06:54Z` 完成封存，报告 5 条发现（1 high：并发错误密码绕过每窗口验证上限；3 medium：登录限速表无界增长、管理员登录缓冲 64 MiB、readiness 回调抛错回显原始异常；1 low：readiness 回显绝对部署路径），覆盖面为 `complete`。

该扫描**不覆盖**其后对 `src/auth-local.ts` 做的一轮修复，需要在下次扫描中一并复核：

1. 限速预留槽位改由 `try/finally` 保证释放——此前凭据查询抛错会让 `pending` 永久滞留，逐次吃掉该窗口的验证额度。
2. 溢出桶由**单个全局** `overflowFailure` 改为**按客户端**的 `overflowFailures`。原实现下，一个客户端用约 4100 次不同用户名的请求填满 4096 条限速记录后，再失败 5 次即可让**任何来源、任何账号**的正确密码登录被拒绝，直到 15 分钟窗口过期；修复后只有一个客户端自己的预算被耗尽。
3. `/readyz` 的报告整形移入同一个保护块：探针**调用成功但返回畸形报告**（`checks` 缺失、非数组或含 `null` 项）此前会在保护块之外抛错，经顶层错误处理器把原始 `error.message` 回给未认证请求，现在与「探针抛错」同样返回固定的 `READINESS_PROBE_FAILED`。

三条都带有回归测试（`test/auth-local.test.ts`、`test/health.test.ts`）。在此扫描封存之后又修改过 `src/auth-local.ts` 和 `src/gateway.ts`，因此不要把该扫描报告当作当前工作区的最终背书。

复核还提出一条**有意保留**的语义，不要当成 bug 去"修"：溢出路径的**成功登录不重置**共享兜底计数（`completeSuccessfulLoginAttempt` 的 overflow 分支只删空桶、不做 `count = 0`），而普通路径会把该账号的窗口清零。这个不对称是刻意的——兜底桶只在账号表被刷满时才生效，若成功登录能刷新它，任何持有一个有效账号的人就能持续为自己买到针对其他账号的新猜测额度。已加代码注释与回归测试锁定该行为。

**未关闭，需要决策后才能发布 `0.1.0`：** 限速作用域是「直连对端地址 + 用户名」，而生产按 [生产部署](03-production-deployment.md) 把 Gateway 放在同机 nginx 之后，所有客户端的对端地址都是 `127.0.0.1`。第 2 条的按客户端分桶在这种拓扑下会退化成原来的全局桶，上面那条 DoS 依旧可达。已写入 [生产部署](03-production-deployment.md) 的「已知限制」和 [SECURITY.md](../../SECURITY.md)；解决方向（受信任对端才采信的客户端地址头，或 Gateway 直接承接 TLS）属于产品决策，未在本轮实施。

-----

## 阶段二：首次推送 GitHub

### 1. 创建空仓库

在 GitHub 创建公开仓库 `xuegaotian/dsh-multiuser`。不要让 GitHub 自动添加 README、`.gitignore` 或 LICENSE，否则远端会产生与本地无关的初始提交。

如果仓库已经存在，先只读检查：

```sh
git ls-remote https://github.com/xuegaotian/dsh-multiuser.git
```

输出为空可能表示远端仓库为空；出现提交 SHA 表示远端已有历史。远端已有历史时先 fetch 和比较，不要直接 force push。

### 2. 审查并提交

先把阶段一的修复全部纳入提交，再查看暂存内容：

```sh
git add -A
git status --short
git diff --cached --stat
git diff --cached --check
git diff --cached
```

确认没有运行数据和密钥后提交：

```sh
git commit -m "Prepare dsh-multiuser for public preview"
```

完成条件：`git status --short` 为空，候选提交包含兼容矩阵、安装与备份实现、测试、CI 和发布文档。

### 3. 配置远端并推送

确认远端为空后执行：

```sh
git branch -M main
git remote add origin https://github.com/xuegaotian/dsh-multiuser.git
git remote -v
git push -u origin main
```

如果 `origin` 已存在，先检查它，不要重复添加：

```sh
git remote get-url origin
```

完成条件：GitHub 的默认分支显示本地候选提交，Actions 自动开始运行，本地 `main` 跟踪 `origin/main`。

-----

## 阶段三：推送后配置 GitHub

### 1. 检查 CI

所有阻断作业必须成功：

- Node 22.19 单元测试、类型检查和构建。
- Node 24 单元测试、类型检查和构建。
- DSH npm `latest` 真实 Runtime 集成测试。
- tarball 安装与 `doctor` 测试，结果不能包含 skip。

alpha canary 可以暂时不阻断，但失败必须记录 Issue，不能只依赖 `continue-on-error` 隐藏。

### 2. 配置仓库安全和协作入口

在 GitHub 完成：

1. 启用 Private Vulnerability Reporting。
2. 启用 Dependabot alerts 和 dependency graph。
3. 为 `main` 设置 branch protection：必须通过阻断 CI、禁止直接 force push、要求分支最新。
4. 确认 Issue 和 Pull Request 模板能正常创建。
5. 设置仓库 description、topics、LICENSE 识别和主页链接。
6. 检查 Actions 默认 token 权限保持只读；发布工作流单独授予 `id-token: write` 和 `contents: read`。

完成条件：`SECURITY.md` 的 PVR 链接能打开私密报告表单，未登录用户能看到 README、LICENSE、贡献指南和发布限制。

### 3. 创建发布证据

新增 `release-evidence/0.1.0-alpha.1.md`，记录：

- Git commit SHA 和干净工作区状态。
- Node、pnpm、DSH、操作系统和浏览器版本。
- 实际执行命令、退出码和非敏感摘要。
- CI 作业链接。
- 未验证项和残余风险。

证据不得包含密码、API key、Cookie、JWT、私钥、公钥全文或用户会话内容。

-----

## 阶段四：发布 npm 预览版

正式版验收尚未完成，因此首个 npm 版本建议使用 `0.1.0-alpha.1`，并通过 `next` tag 发布，避免普通用户从 `latest` 自动获得预览版。

### 1. 准备 npm 账号

```sh
npm login
npm whoami
npm view dsh-multiuser name version
```

完成条件：`npm whoami` 返回你的 npm 用户名，账号启用 2FA，包名查询仍返回 `404`。

### 2. 设置预发布版本

```sh
npm version 0.1.0-alpha.1 --no-git-tag-version
pnpm install --lockfile-only
```

检查 `package.json` 和 lockfile 只发生预期的版本变化，然后重新执行阶段一第 7 节的全部候选提交检查。

### 3. 预演发布

```sh
npm publish --dry-run
```

确认包名、版本、文件清单、README、LICENSE、repository 和 bin 正确。然后提交版本变更并创建带签名或受保护的标签。

### 4. 发布预览版

推荐通过 GitHub Actions 的受保护 environment 发布，并启用 npm trusted publishing/provenance。发布工作流应从标签对应的干净 commit 构建，不使用维护者工作区里的 tarball。

人工发布仅作为首次验证的备选：

```sh
npm publish --tag next --provenance --access public
```

发布后读回：

```sh
npm view dsh-multiuser@0.1.0-alpha.1 version dist.integrity repository --json
npx dsh-multiuser@0.1.0-alpha.1 --version
```

完成条件：registry 返回的 repository 指向 `xuegaotian/dsh-multiuser`，版本和 Git tag 对应同一 commit，并能在全新目录运行 CLI。

-----

## 阶段五：正式 v0.1.0 验收

预览版可以公开代码和收集反馈，但下面的项目完成之前不能宣称 production-ready。

### 1. 全新 Linux 主机部署

严格按照 [生产部署](03-production-deployment.md) 在全新 Linux VM 上执行：服务账号、目录权限、Node、DSH、systemd、HTTPS 反向代理、WebSocket、真实 IdP、主机重启和服务自启动。

### 2. 两用户真实浏览器隔离

使用两个独立浏览器上下文登录用户 A 和 B，验证会话、事件、workspace、上传下载、设置、凭据、私有插件、Skill、MCP、子 agent 和 Runtime Cookie 不串线。测试必须包含“B 枚举 A 的资源”和“B 直接请求 A 的已知 ID”两种负向路径。

### 3. 公共和私有资源生命周期

验证公共插件、Skill 和 MCP 的增加、更新、删除，以及 A 的私有资源在每次 Runtime 重启后仍然保留。确认管理 API、审计日志和错误输出不返回密钥值。

### 4. 升级、恢复和回滚

至少演练：

1. 当前预览版安装并创建数据。
2. 备份数据库、用户目录、共享模型配置和部署配置。
3. 升级应用和 DSH 补丁版本。
4. 验证旧会话、workspace 和私有配置。
5. 恢复到另一目录或主机。
6. 用升级前数据备份回滚旧应用，证明 Schema 匹配。
7. 卸载时保留数据，再重新安装并读回原数据。

### 5. 新用户文档测试

请一名没有参与开发的人仅依靠公开 README 和部署文档完成安装。维护者只记录卡点，不提供额外命令。修正文档后重新从空环境执行受影响步骤。

### 6. 正式发布产物

正式 `v0.1.0` 需要：

- `CHANGELOG.md` 和 GitHub Release notes。
- Release tarball 的 SHA-256。
- SBOM 和第三方许可证说明。
- npm provenance。
- `release-evidence/0.1.0.md`。
- 公开发布后的全新目录安装读回。

-----

## 最终放行表

| 检查点 | 推 GitHub `main` | npm alpha | npm `v0.1.0` |
| --- | --- | --- | --- |
| 权属确认、密钥扫描 | 必须 | 必须 | 必须 |
| CI tarball 不再静默跳过 | 必须 | 必须 | 必须 |
| Node 22.19/24 CI | 必须 | 必须 | 必须 |
| install/upgrade 文档与行为一致 | 必须 | 必须 | 必须 |
| GitHub PVR、模板、分支保护 | 推送后完成 | 必须 | 必须 |
| 真实 DSH 和 tarball 测试 | 必须 | 必须 | 必须 |
| 全新 Linux/systemd/HTTPS | 可待办并明确说明 | 可待办并明确说明 | 必须 |
| 双浏览器隔离和资源生命周期 | 可待办并明确说明 | 可待办并明确说明 | 必须 |
| 升级、备份恢复、Schema 回滚 | 可待办并明确说明 | 可待办并明确说明 | 必须 |
| SBOM、provenance、正式发布证据 | 可待办 | 建议 | 必须 |

最短的下一步顺序是：完成最终安全与候选提交检查 → 审查并提交 → 确认空 GitHub 仓库 → 添加 origin → 推送 `main` → 观察 CI → 开启 PVR、Dependabot 和分支保护 → 配置 npm 发布身份 → 发布 `next` 标签的预览版。

## Dev Note

本文记录 2026-09-17 工作区的发布顺序。GitHub 仓库是否已经创建、PVR 是否启用、npm 包名是否仍可用，以及 DSH dist-tag 都属于外部状态；每次发布前必须重新查询。
