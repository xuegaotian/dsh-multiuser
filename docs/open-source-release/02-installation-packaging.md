# 安装与打包

状态：已实施（2026-09-16 核心完成；2026-09-17 npm 包名 `dsh-multiuser` 与 GitHub 仓库 `github.com/xuegaotian/dsh-multiuser` 已确定并替换占位符）  
目标：让用户通过一个版本化发布包完成安装，无需同时 checkout `dsh-multiuser` 和 DeepSeek Harness 源码仓库。

实施结果：

- `package.json` 具备 `bin`（`dsh-multiuser` → `dist/src/cli.js`）、`files`（dist、Bundle、Profile 模板、deploy、compatibility.json、README、LICENSE、SECURITY.md）和 `publishConfig.access: public`。
- 采用推荐的**内置 Bundle** 方案：发布包同时携带 `packages/bundle/user-runtime` 与 `profiles/user-runtime`，两者同级的相对结构使 `prepareUserProfile` 在部署目录中同样成立；`install` 把完整文件树（含 `npm install --omit=dev` 后的依赖）原子装入目标目录。
- `doctor` 为只读命令，带稳定结果码（`NODE_VERSION`、`DSH_VERSION`、`DSH_COMPATIBILITY`、`DB_PERMISSION`、`DATA_PERMISSION`、`PROFILE_SOURCE`、`PROFILE_COMPOSITION`、`SSO_CONFIG`、`SECURE_COOKIES`），支持 `--json`；在独立临时 home 中用真实 `--dump-config` 验证 Profile，不触碰部署数据。
- `install` 幂等：staging → 真实 `--dump-config` 验证 → 原子替换应用目录 → 保留数据目录；重复执行报告 "database already exists — accounts and sessions preserved"（实测通过）。
- 预览版不提供在线 `upgrade`；生产升级统一执行“停止服务 → `backup` → 安装新版本 → 启动服务 → 验证”。`uninstall` 默认保留数据，`--purge-data` 拒绝根目录/用户 home/工作区根目录（实测通过）。
- tarball 验收通过：`npm pack` 产物在空目录 `npm install` 后 `--help`、`doctor`（解析包内 compatibility.json）、`init-admin`、完整 Gateway 启动（admin 登录页 200、admin API 可用）全部正常；包内容不含 `.env`/SQLite/日志/PEM/私钥/`.ts` 源码/source map/本机绝对路径/tsx 依赖。

## 先明确安装边界

当前项目包含两类不同产物：

| 产物 | 职责 | 能否只用 `dsh plugin add` 安装 |
| --- | --- | --- |
| Runtime Bundle | 修改每用户 DSH Profile 的 Cordis 配置 | 能 |
| Gateway 控制面 | 认证、账号、Runtime 进程、代理、管理页和公共资源 | 不能 |

`dsh plugin --profile <name> add <package>` 只负责安装 Bundle 并把其 patch 加入 Profile。它不应隐式创建系统账号、写入 `/etc`、安装 systemd 单元、配置 TLS 或导入 SSO 公钥。

因此，目标是达到“和插件一样容易安装”，而不是声称整个系统就是一个普通 DSH 插件。

## 推荐的发布形态

发布一个 npm 应用包，例如 `dsh-multiuser`。该包同时携带：

- 预编译 Gateway 和管理 CLI。
- Runtime Bundle 的 `package.json` 和 `cordis.patch.yml`。
- `user-runtime` Profile 模板。
- systemd 和反向代理模板。
- 版本兼容元数据。

用户入口为：

```sh
npx dsh-multiuser@<version> doctor
npx dsh-multiuser@<version> install --mode local
```

生产部署可以使用同一发布包的系统安装模式：

```sh
sudo npx dsh-multiuser@<version> install --mode systemd
```

上述命令是发布包的安装入口；生产升级不要调用 `upgrade`，请按 [生产部署](03-production-deployment.md) 的停止、备份、安装、启动和验证流程执行。

## 第一阶段：选定名称和所有权

已于 2026-09-17 完成。取值和完整操作步骤见 [仓库身份与发布主体](05-repository-identity.md)。

1. GitHub 账号：`xuegaotian`（个人账号，非组织）。
2. npm 包名：无 scope 的 `dsh-multiuser`。发布前用 `npm whoami` 确认当前登录账号。
3. 仓库所有者占位符已被 `scripts/set-repository-identity.sh --github-owner xuegaotian` 一次性替换，`package.json`、`SECURITY.md` 与各章文档中不再有该类占位符（部署手册里的域名、版本、路径占位符是另一回事，仍需按实际环境填写）。
4. 确定包名未被占用：

```sh
npm view dsh-multiuser name version
```

`404` 只表示当前没有公开包，不代表当前 npm 账号有权发布该 scope。发布前使用 `npm whoami` 和 npm 组织权限页面确认。

## 第二阶段：重构包内容

### 根 package.json

根包至少需要以下发布字段：

```json
{
  "name": "dsh-multiuser",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "dsh-multiuser": "dist/src/cli.js"
  },
  "files": [
    "dist/src/**/*.js",
    "packages/bundle/user-runtime/package.json",
    "packages/bundle/user-runtime/cordis.patch.yml",
    "profiles/user-runtime/package.json",
    "profiles/user-runtime/pnpm-workspace.yaml",
    "profiles/user-runtime/cordis.patch.yml",
    "deploy/**",
    "README.md",
    "LICENSE"
  ],
  "publishConfig": {
    "access": "public"
  }
}
```

实施时根据 `npm pack --dry-run` 输出调整 `files`。不要发布测试数据、SQLite、日志、`.env`、公私钥、源码 map 或本机绝对路径。

### Runtime Bundle

当前 Bundle 的 `private: true` 阻止独立发布，Profile 又使用 `file:../../packages/bundle/user-runtime`。两种实施方案只选一种：

1. **推荐：内置 Bundle**。Gateway 安装器把包内的 Bundle 复制到部署数据目录，再为每个 Profile 建立可验证的本地依赖。用户只安装一个 npm 包。
2. **独立 Bundle 包**。发布 `dsh-multiuser-runtime` 并让 Profile 依赖与 Gateway 版本完全一致的精确版本。

不要保留一个只在 monorepo 目录层次内才成立的 `file:../../...` 依赖作为发布设计。

## 第三阶段：实现 doctor

`doctor` 必须是只读命令，检查并显示：

- Node 版本是否满足 DSH 的 `^22.19.0 || >=24.0.0`。
- `dsh` 是否可执行以及精确版本。
- DSH 版本是否出现在 `compatibility.json`。
- 数据目录、数据库目录、公钥和配置文件的存在性与权限。
- Profile 能否通过 `dsh --profile user-runtime --dump-config`。
- Gateway 端口、Runtime 端口和反向代理上游是否冲突。
- 是否启用安全 Cookie，生产配置是否误用 `--insecure-cookies`。
- SSO 选项是全部配置或全部缺失，不显示公钥文本或任何 token。

输出使用稳定结果码，例如 `DSH_VERSION_UNSUPPORTED`、`PROFILE_INVALID`、`DATA_PERMISSION_UNSAFE`，方便 CI 和运维工具处理。

## 第四阶段：实现幂等 install

`install` 必须先生成计划，再执行。至少支持：

```sh
dsh-multiuser install --mode local --dry-run
dsh-multiuser install --mode local
dsh-multiuser install --mode systemd --dry-run
dsh-multiuser install --mode systemd
```

安装器按固定顺序执行：

1. 检查 Node、DSH 和操作系统。
2. 解析所有目标绝对路径。
3. 检查目标中是否有旧版本或用户数据。
4. 在独立临时目录准备完整文件树。
5. 运行 Profile 安装和 `--dump-config` 验证。
6. 原子替换应用目录，保留数据目录。
7. 首次安装才初始化管理员；重复执行不覆盖账号、密钥或 Profile。
8. 执行 `doctor`，并在任何检查失败时保留上一个可用版本。

`--dry-run` 不创建目录、不安装依赖、不修改 Profile、不写数据库，只显示精确目标和操作。

## 第五阶段：升级边界与 uninstall

预览版不提供在线 `upgrade` 命令。Gateway 运行期间复制应用或数据目录不能保证 SQLite、会话和运行进程的一致性，因此 CLI 会明确拒绝该命令，不执行备份、复制或安装。

生产升级唯一支持的顺序是：停止服务、执行 `backup`、用新版本执行 `install`、启动服务并验证 `/readyz`、版本和业务链路。完整命令见 [生产部署](03-production-deployment.md#升级与回滚)。

`uninstall` 默认只停止并移除应用和服务定义，保留数据。只有显式 `--purge-data` 才允许删除数据，必须显示绝对目标、二次确认并拒绝根目录、用户 home 或工作区根目录。

## 第六阶段：验证发布包

每次发布前从实际 tarball 测试，不从仓库源码直接运行：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build

PACK_DIR=$(mktemp -d)
pnpm pack --pack-destination "$PACK_DIR"
npm install --prefix "$PACK_DIR/consumer" "$PACK_DIR"/*.tgz
"$PACK_DIR/consumer/node_modules/.bin/dsh-multiuser" --help
"$PACK_DIR/consumer/node_modules/.bin/dsh-multiuser" doctor
```

然后检查包内容：

```sh
npm pack --dry-run
tar -tf "$PACK_DIR"/*.tgz
```

失败条件：

- 包内包含 `.env`、数据库、日志、PEM、私钥或本机绝对路径。
- CLI 依赖 `tsx`、项目源码或未列入 `files` 的资源。
- Runtime Profile 依赖仓库目录结构才能解析。
- `doctor` 或 `--help` 会创建数据、修改 Profile 或启动端口。

## 第七阶段：验证插件体验

如果单独发布 Runtime Bundle，必须验证标准 DSH 命令：

```sh
export DSH_PLUGIN_TEST_HOME="$PWD/plugin-test-home"
DSH_HOME="$DSH_PLUGIN_TEST_HOME" dsh plugin --profile user-runtime add dsh-multiuser-runtime@<version>
DSH_HOME="$DSH_PLUGIN_TEST_HOME" dsh --profile user-runtime --dump-config
DSH_HOME="$DSH_PLUGIN_TEST_HOME" dsh plugin --profile user-runtime remove dsh-multiuser-runtime
```

若采用推荐的内置 Bundle 方案，README 应只展示 `dsh-multiuser install`，不让用户手工管理内置 Bundle。

## 完成标准

- [x] 新机器只需已安装的 Node 和 DSH，不需要两个源码 checkout（tarball 空目录安装实测通过）。
- [x] 一个 npm 包或 GitHub Release tarball 包含所有必需非敏感文件（`npm pack` 内容清单已核对）。
- [x] `install` 可重复执行，不覆盖数据和用户私有 Profile 内容（重复 install 实测保留账号与数据）。
- [x] `doctor` 在支持和不支持的 DSH 版本上都给出明确结果（`DSH_COMPATIBILITY` 结果码区分 tested/canary/未知版本，单元测试覆盖）。
- [ ] 从 tarball 安装的产物通过真实 Runtime 和浏览器验收（Gateway 启动与 admin 链路已通过；完整双用户浏览器验收属于手册第 4 章）。
- [x] 卸载默认保留数据，已完成卸载后重装恢复演练（uninstall 保留 `gateway.sqlite` 实测通过；重装后数据完好）。
