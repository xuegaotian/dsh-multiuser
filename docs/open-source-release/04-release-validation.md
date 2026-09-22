# 发布验收

状态：待实施  
目标：将“可以开源”变成一组可重复、可审计的发布条件。

## 验收记录

为每个候选版本创建 `release-evidence/<version>.md`，记录：

- Git commit 和工作区是否干净。
- Node、pnpm、DSH、操作系统和浏览器版本。
- 实际执行的命令及退出码。
- 真实 Runtime、SSO、反向代理、隔离、升级和恢复结果。
- 未验证的平台和残余风险。

记录只保留非敏感证据。不得包含 API key、密码、Cookie、JWT、私钥、公钥完整文本或用户会话内容。

## 第一关：仓库内容

检查仓库没有开源前占位和本机残留：

```sh
rg -n "<owner>|/Users/|/home/|example\.internal|TODO|FIXME" \
  README.md SECURITY.md CONTRIBUTING.md package.json docs deploy src test \
  --glob '!docs/open-source-release/04-release-validation.md' \
  --glob '!docs/open-source-release/05-repository-identity.md'
git ls-files
git status --short
git diff --check
```

`example.com` 可以作为标准文档占位域名，但必须在示例前明确提示替换。仓库所有者的占位符、本机绝对路径和内部域名必须清零。

上面两条 `--glob` 排除的是两处**按设计必须保留占位符字样**的文件：本文件包含这条检查命令本身，第 5 章包含同类命令。不排除的话命令会自指、永远报警，把关就失效了。这两处只有命令模式，不含实际占位符。

必须存在并完成以下文件：

- `README.md`
- `LICENSE`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `.gitignore`
- `.github/workflows/ci.yml`
- Issue 和 Pull Request 模板
- `CHANGELOG.md`
- `compatibility.json`

## 第二关：许可证和供应链

1. 确认项目 LICENSE 与 `package.json` 一致。
2. 对所有 runtime dependency 生成许可证列表。
3. 确认打包中的 DSH 文件、第三方前端资源、图片和字体可以再分发。
4. 将必要的 copyright 和 license text 放入 `THIRD_PARTY_NOTICES.md`。
5. 锁定 GitHub Actions 权限为最小值，发布作业使用 npm provenance 和受保护的 environment。
6. 对 release tarball 生成 SBOM，至少包含包名、版本和许可证。

可用的基础检查：

```sh
pnpm licenses list --prod
pnpm audit --prod
npm pack --dry-run
```

`pnpm audit` 的结果必须经过影响分析；既不忽略真实可达漏洞，也不把所有间接开发依赖告警自动当作发布阻断。

## 第三关：静态检查和单元测试

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

CI 不只运行 Node 22 的模糊主版本。至少包含 DSH 支持的最低 Node `22.19.x` 和一个当前 Node 24 LTS 版本。

每个安全敏感解析器必须有一个有效 fixture 和至少一个无效 fixture，特别是：

- SSO JWT header 和 claims。
- Host、Origin、Cookie 和 WebSocket upgrade。
- Profile manifest 和公共 MCP 配置。
- 文件名、Skill 包和插件 spec。
- 数字参数，包括端口、Runtime 数量、空闲时间和 body 限制。

## 第四关：真实 DSH 集成测试

测试必须从 npm 安装锁定 DSH 版本，并从 `npm pack` 生成的本项目 tarball 安装。不允许因为相邻 checkout 或开发 `node_modules` 而假通过。

至少覆盖：

1. 初始化 Profile 并通过 `--dump-config`。
2. 启动 Gateway，再由真实用户请求触发 DSH Runtime。
3. 完成 Runtime 启动 token 与 Cookie 交换。
4. 通过 HTTP RPC 列出、创建、打开和分页读取会话。
5. 通过 WebSocket 接收一次完整流式回复，并测试中断和重连。
6. 执行文件上传和下载，确认用户目录归属正确。
7. 停止 Gateway，确认子 Runtime 退出。
8. 重启 Gateway，确认会话和 Profile 恢复。

模型流式测试优先使用确定性 mock provider。真实 API 测试单独运行，缺少密钥时明确 skip，不把其作为基础传输的唯一证据。

## 第五关：两用户隔离验收

使用两个独立浏览器上下文，分别以 A 和 B 登录。对以下每项都执行“A 创建，B 尝试枚举和直接访问”：

| 资源 | 预期结果 |
| --- | --- |
| 会话和会话事件 | B 无法枚举，使用 A 的 ID 直接请求也失败 |
| workspace 文件 | B 不可列出、读取、覆盖或下载 |
| DSH 设置和凭据 | B 无法读取 A 的值或配置状态 |
| 私有插件、Skill 和 MCP | B 不可发现或调用 |
| Runtime 端口 | 浏览器不能直接访问，且 A/B 请求不会串线 |
| 子 agent 和事件流 | B 收不到 A 的创建、输出或完成事件 |

同时记录限制：A/B Runtime 以同一 OS 账号运行，所以上述结果证明应用路由和目录所有权，不证明能对抗恶意 Runtime 代码。

## 第六关：公共与私有资源验收

必须验证增加、更新、删除三种变化，而不是只测试第一次复制：

1. A/B 都启动一次。
2. A 安装一个私有插件、Skill 和 MCP。
3. 管理员添加公共插件、Skill 和 MCP。
4. 重启 A/B，确认公共资源对两者可见，私有资源只对 A 可见。
5. 更新公共资源，重启 A/B，确认两者获得新版本。
6. 删除公共资源，重启 A/B，确认该资源不再存在，A 的私有资源仍存在。
7. 检查管理 API 和审计日志不返回 MCP header/env 值和模型 API key。

## 第七关：部署生命周期

在全新 Linux 虚拟机上依次执行：

1. 安装。
2. 首次初始化。
3. 主机重启。
4. 应用重启。
5. DSH 补丁版本升级。
6. `dsh-multiuser` 升级。
7. 备份恢复到另一目录或主机。
8. 应用版本回滚。
9. 默认保留数据的卸载。
10. 使用保留数据重新安装。

数据库格式升级后如果旧代码不能打开，回滚必须同时恢复升级前的数据备份，不得将旧二进制直接指向新 Schema。

## 第八关：文档新用户测试

请一名没有参与实现的人只使用公开 README 和部署手册操作。维护者只记录卡点，不提供口头命令。

新用户必须能回答：

- 这个项目适合哪种团队，不适合哪种威胁模型。
- 需要哪个 DSH 版本。
- 如何安装、登录、验证 Runtime、查看状态和日志。
- 如何升级、备份、回滚和卸载。
- 遇到不支持的 DSH 版本或 SSO 失败时到哪里排查。

## 第九关：发布候选产物

从干净 commit 生成候选包：

```sh
git status --short
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build

RELEASE_PACK_DIR=$(mktemp -d)
pnpm pack --pack-destination "$RELEASE_PACK_DIR"
sha256sum "$RELEASE_PACK_DIR"/*.tgz
npm pack --dry-run
```

用该 tarball 重新执行第四至第八关。验收期间不再从开发工作区启动 Gateway。

## 第十关：公开发布

发布前完成：

- [ ] GitHub 仓库地址、npm scope、维护者和安全联系方式已确认。
- [ ] GitHub Private Vulnerability Reporting 已启用。
- [ ] `v0.1.0` 发布说明包含支持范围、限制、安装、升级和已知问题。
- [ ] npm 发布启用 provenance，包的 repository commit 与 Git 标签一致。
- [ ] GitHub Release 附带 tarball SHA-256 和 SBOM。
- [ ] 公开后从 npm registry 在新目录重新安装，并读回版本与健康信息。

公开后的最终读回：

```sh
npm view dsh-multiuser@0.1.0 version dist.integrity repository --json
npx dsh-multiuser@0.1.0 --version
```

## 发布后维护节奏

- 每周检查 DSH `latest`、`next` 和 `alpha` dist-tag。
- DSH 新 `latest` 出现后立即运行兼容 CI，失败时不自动扩大支持范围。
- 安全漏洞使用私密渠道处理，修复版本发布后再协调披露。
- 每个版本保留至少一份真实部署证据和一份升级/回滚证据。
- 不受支持的平台由社区贡献者维护时，必须在 CI 中有对应作业后才进入支持列表。

## 发布决策

任何一个阻断条件未通过，只能发布为带明确限制的 `experimental` 预览，不能声称 production-ready。尤其不得用单元测试通过代替真实 DSH Runtime、两用户隔离、新机器安装和备份恢复证据。

