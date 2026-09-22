# 开源发布实施手册

状态：第 1 章（DSH 兼容升级）、第 2 章（安装与打包）与第 5 章（仓库身份）已完成，第 3、4 章待实施  
对象：首次公开发布 `dsh-multiuser` 的维护者  
验收原则：每个完成项都必须有命令输出、测试记录或发布产物，不以代码存在代替真实验收。

## 目标

完成本手册后，一名没有本地项目背景的 Linux 管理员应能安装指定版本的 DeepSeek Harness，用一个发布包安装 `dsh-multiuser`，完成本地管理员与 SSO 配置，启动受管网关，并用两名普通用户证明 Runtime、会话和私有配置互不可见。

项目定位和已有方案对比见 [多用户 AI Coding Agent 开源项目调研](../open-source-landscape-2026-09.md)。

从当前工作区开始执行时，先按 [从当前工作区到正式发布](06-next-steps.md) 区分 GitHub 首次推送、npm 预览版和正式 `v0.1.0` 的放行条件。

## 发布阻断项

### 1. DeepSeek Harness 兼容性

- [x] 支持 npm `latest` 指向的 DSH 版本。截至 2026-09-17，该版本是 `0.1.5-rc.2`（真实 Runtime 集成测试 11/11 通过）。
- [x] 对 npm `alpha` 指向的最新预发布版执行前瞻测试。截至 2026-09-17，该版本是 `0.1.6-alpha.2`（集成测试同样通过）。
- [x] 真实 DSH Runtime 集成测试进入 CI，不再只使用 `FakeRuntimeProvider`（`.github/workflows/ci.yml` 的 `integration-latest` / `integration-alpha` 作业）。
- [x] 发布版本声明精确支持的 DSH 范围，不使用“最新版”作为模糊承诺（`compatibility.json` + README 支持版本声明）。

执行步骤见 [DSH 兼容升级](01-dsh-compatibility.md)。

### 2. 可安装的发布产物

- [x] 确定 npm scope 和真实 GitHub 仓库地址。（取值：无 scope 包名 `dsh-multiuser`，仓库 `github.com/xuegaotian/dsh-multiuser`；占位符已全部替换。仓库创建、推送与 Private Vulnerability Reporting 启用见第 5 章步骤 4–5）
- [x] 根包发布 Gateway、CLI、Runtime Bundle 和 Profile 模板，用户不需要第二个 checkout。（`files` 携带 dist、Bundle、Profile、deploy、compatibility.json；tarball 空目录安装实测通过）
- [x] 删除 Runtime Bundle 对仓库相对 `file:` 路径的发布时依赖。（采用内置 Bundle 方案：发布包内 `packages/` 与 `profiles/` 同级，相对结构在部署目录成立，Profile 的 `file:../../` 仅在安装后的部署树内解析）
- [x] 提供幂等的 `install`、`doctor`、`start`、`stop`、`status` 和 `uninstall` 命令；预览版明确禁用 `upgrade`。（重复 install 保留数据、`--dry-run` 无副作用、`--purge-data` 安全拒绝均已实测）
- [x] `npm pack` 产物在空目录安装后可运行，不读取开发仓库或相邻 DSH checkout。（`--help`、`doctor`、`init-admin`、完整 Gateway 均从 tarball 安装产物实测通过；包内容无敏感文件/绝对路径/tsx 依赖）

执行步骤见 [安装与打包](02-installation-packaging.md)；名称与所有权决策见 [仓库身份与发布主体](05-repository-identity.md)。

### 3. 完整部署手册

- [ ] 声明首个受支持的生产环境，建议限定为 Linux + systemd + HTTPS 反向代理。
- [ ] 从空主机开始的步骤包含目录、服务账号、DSH、Gateway、SSO 公钥、TLS 代理、验收和备份。
- [ ] 每个步骤都给出成功信号和失败恢复方法。
- [ ] 提供健康检查和就绪检查，不把登录页返回 `200` 当作完整链路成功。

执行步骤见 [生产部署](03-production-deployment.md)。

### 4. 发布验收和维护

- [ ] 两名用户的真实浏览器隔离验收通过。
- [ ] 公共和私有插件、Skill、MCP 的更新、删除和 Runtime 重启验收通过。
- [ ] 备份恢复和上一应用版本回滚演练通过。
- [ ] 许可证、第三方通知、密钥扫描、依赖审计和发布包内容检查通过。
- [ ] GitHub 责任人、漏洞报告通道、Issue 模板、发布说明和兼容策略已生效。

执行步骤见 [发布验收](04-release-validation.md)。

## 你列出的三个问题之外，还需要处理的问题

1. **产品边界**：必须在 README 首屏说明它面向可信内部用户，不提供恶意租户级 OS 隔离。
2. **包形态不一致**：根 `dsh-multiuser` 是外部控制面，只有 `packages/bundle/user-runtime` 是 DSH Bundle。必须分别说明应用安装和 Bundle 激活。
3. **真实隔离证据**：当前单元测试大量使用伪 Runtime，需要两个真实 DSH 进程、两个浏览器上下文的证据。
4. **升级与数据格式**：SQLite Schema、Profile 合并记录和 DSH 会话数据必须有升级前备份与不可降级说明。
5. **可运维性**：Gateway 已提供稳定的 `/healthz`、`/readyz` 和 `/version` 端点；结构化日志和资源指标仍不在首个预览版承诺范围内。
6. **资源约束**：`maxActiveRuntimes` 限制数量，但没有 CPU、内存、进程数、磁盘和网络限制。必须把这一点写成明确限制。
7. **发布供应链**：发布包已具备 `bin`、`files`、`publishConfig` 和完整仓库地址；npm Trusted Publishing、provenance、SBOM 和正式发布流程仍需按第 4 章完成。
8. **安全报告通道**：`SECURITY.md` 的占位链接已替换为真实仓库地址；Private Vulnerability Reporting 需在仓库创建后于 Settings → Security 中启用。
9. **使用者入口**：只初始化管理员不能演示多用户；需要一个仅用于本机的测试 IdP/JWT 签发工具和端到端教程。
10. **国际化和可访问性**：中文优先可以是首个版本的选择，但管理页文案、README 语言范围和无障碍支持必须明确声明。

## 建议的实施顺序

1. 先完成 DSH `0.1.5-rc.1` 兼容改造和真实 Runtime 测试。
2. 再重构发布包，使空目录安装和 `doctor` 通过。
3. 在全新 Linux 虚拟机上执行生产部署手册，边执行边修正文档。
4. 完成两用户隔离、公私资源、备份恢复和回滚演练。
5. 最后才替换仓库占位元数据、创建 `v0.1.0` 标签和公开仓库。

## 最终完成定义

只有同时满足以下条件，才把项目标记为可公开发布：

- 新用户仅使用公开文档就能完成安装，维护者不提供口头补充。
- npm 包和 GitHub Release 中的代码、版本、校验和文档一致。
- DSH `latest` 矩阵、项目单元测试、打包安装测试、真实浏览器测试和回滚演练全部有可审计记录。
- README 明确说明支持版本、信任模型、规模限制、安装方式和不支持项。
