# 多用户 AI Coding Agent 开源项目调研（2026-09）

访问日期：2026-09-15

## 结论

`dsh-multiuser` 仍有开源价值，但前提是把定位收窄为 **DeepSeek Harness 的多用户、自托管控制面和参考部署**，而不是泛化地宣称自己是市场上少见的“多用户 AI 编码平台”。

截至本次调研，已经存在多项 **DSH-native 直接替代品**。其中 `dshcloud` 的平台能力最完整，以每 workspace 独立容器、持久存储、访问控制、资源配额和版本管理为核心；`dsh-server-deployment` 与 `dsh-hub` 的运行模型最接近本项目，都是每用户一个独立 DSH 实例，并用独立 OS UID/GID 和回环端口规则建立更强的主机隔离。它们应排在通用平台 Coder 之前比较。

`dsh-passwords` 和 `dsh-login` 是更轻量的 DSH 插件级竞品：二者都在一个 DSH 部署内增加账号与权限控制，而不是为每用户启动完整 Runtime。`dsh-passwords` 重点提供账号、工作区/会话授权和配额；`dsh-login` 提供会话归属及默认用户工作区，但其 README 明确说明 per-user REMOTE guard 仍需在启动时组合，并完成双浏览器行为验收，不能把当前发布包视为已完成端到端隔离验证。

在非 DSH 生态中，**Coder Agents 是最接近的通用开源直接替代品**：它已经覆盖自托管、多用户身份、OIDC、用户专属 workspace、原生 coding-agent loop、集中模型配置、系统指令、Skill 和 MCP 管理。它与 `dsh-multiuser` 的主要差异不是功能多少，而是架构和生态：Coder 在共享控制面运行自己的 agent loop，通过用户拥有的 Coder workspace 执行工具；`dsh-multiuser` 为每个用户启动原版 DSH Runtime，并保留 DSH Profile、Bundle、插件及用户私有配置语义。

**OpenHands Enterprise** 在产品能力上也高度重合，甚至提供更强的沙箱、RBAC、SAML 和插件市场，但官方明确把这些能力放在商业版；其开源 Agent Canvas 不提供多用户组织、认证授权、隔离沙箱、强制默认模型或插件市场。因此它不是完整的开源替代品。

**LibreChat** 正在从聊天门户向带代码 workspace 的 agent 平台靠近，且已经具备多用户认证、Agent、Skill、插件和 MCP；不过官方仍把 Attached Code Workspaces 标为 highly experimental，其执行模型也不是“每用户独立 Harness Runtime”。它是需要持续关注的部分替代品。

所以，“网上是否已有相同项目”的答案是：**有，而且同一 DSH 生态中已有多个直接竞品。** 但本次仍未发现另一个项目同时完整覆盖 `DeepSeek Harness + 每用户独立 Runtime + 外部 IdP 签发的 Ed25519 JWT SSO + 管理员统一分发模型/Skill/插件/MCP + 公共/私有 Profile 资源合并`。本项目的差异点已经从“有没有 DSH 多用户方案”缩小为“是否能把认证、Runtime 生命周期与 DSH 公共资源治理做成一个清晰、可验证的轻量实现”。

## 判定口径

本报告用以下七项判断项目是否能直接替代 `dsh-multiuser`：

1. 产品核心是 AI coding agent 或 agent harness，而非普通聊天/RAG 门户。
2. 支持多用户认证和用户身份绑定。
3. 每个用户有独立的执行环境或 workspace。
4. 用户有独立配置、凭据或持久数据。
5. 管理员可统一分发或治理模型、Skill、插件、MCP 等能力。
6. 支持企业 SSO。
7. 可自托管，并且上述关键能力属于可获得的开源版本。

表中的“未见公开支持”仅表示在本次查阅的官方仓库和官方文档中没有找到明确承诺，不等于证明源代码绝对不存在该能力。版本和商业边界会变化，选型前应重新核对。

## 总览矩阵

| 项目 | 分类 | Coding agent / harness | 多用户认证 | 独立 runtime / workspace | 管理员统一分发 | SSO | 自托管开源关键能力 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dshcloud | DSH-native 直接替代品 | 是，运行原版 DSH | 是，邀请用户 | 每 workspace 独立容器、数据目录和资源配额；每用户可建多个 workspace | 管理员管理用户、配额、镜像版本；未见统一模型/Skill/插件/MCP 分发 | 未见公开支持 | 是，MIT；README 标明 early development，完整实例链路仍有未验证项 |
| dsh-server-deployment | DSH-native 直接替代品 | 是，运行原版 DSH | 是，本地账号 | 每用户独立 DSH 实例、端口、OS 账号、`DSH_HOME` 和 API Key | 用户生命周期和预置 Key；未见公共 Skill/插件/MCP 分发 | 未见公开支持 | 是，MIT；面向 Linux 服务器/systemd |
| dsh-hub | DSH-native 直接替代品 | 是，运行原版 DSH | 是，PAM | 每系统用户独立 DSH 实例、uid/gid、`DSH_HOME`，iptables owner guard | 用户 allow-list；插件由各用户自行安装 | PAM，不是通用 OIDC/SAML SSO | 是，MIT；非 root 仅为降级开发模式 |
| dsh-passwords | DSH-native 部分替代品 | 是，DSH 插件 | 是，主用户和子用户 | 单个 DSH 部署；按工作区/会话做权限与配额，不是每用户 Runtime | 主用户分配工作区、会话、token/时长、沙箱及上传下载权限 | 未见公开支持 | 是，GPL-3.0-only |
| dsh-login | DSH-native 部分替代品 | 是，DSH 插件 | 是，本地管理员和普通用户 | 单 DSH 进程；按会话归属过滤并创建用户名目录下的默认 workspace | 管理账号和能力限制；不分发公共模型/Skill/插件/MCP | 未见公开支持 | 是，MIT；per-user guard 尚未完成 boot 组合与双浏览器验证 |
| WebDSH | DSH-native 设计方案 | 目标是运行原版 DSH | 设计中 | 设计为每用户独立进程和 `DSH_HOME`，OS 隔离后续强化 | 设计包含账号、审计、配额、共享 workspace | 设计文档未形成可部署实现 | MIT 仓库，但 README 明确尚待新增 gate/plugin 源码 |
| Coder Agents | 通用直接替代品 | 是，原生 agent loop | 是 | 是，用户拥有的 Coder workspace；loop 在共享控制面 | 模型、系统指令、模板、MCP；Skill 可由模板/用户提供 | OIDC | 是；Community License 同时运行最多 5 个 agent |
| OpenHands Agent Canvas / Enterprise | 商业直接替代品 | 是 | OSS 否，Enterprise 是 | OSS 本地后端无隔离 sandbox；Enterprise 支持 | OSS 有个人配置；组织 Skill、强制模型、插件市场属于 Enterprise | SAML 仅 Enterprise | 完整多用户能力不是开源版 |
| LibreChat | 部分替代品 | 是，通用 Agent；代码 workspace 尚属实验能力 | 是 | Managed / personal attached workspace，但官方标为 highly experimental | 模型端点、Agent、Skill、插件、MCP 和权限 | OAuth2、LDAP、OIDC/SAML 文档齐全 | 是，但 coding workspace 成熟度不足 |
| Open WebUI | 相邻项目 | 以模型/Agent 门户为主 | 是 | 开源核心未提供等价的每用户 coding runtime；Terminals 的每用户隔离容器为 Enterprise 产品 | 模型、Agent、Tools、Skills、MCP 和组权限 | OAuth/可信头；企业目录能力另有产品层 | 核心可自托管，但等价执行隔离不在开源核心 |
| Archon | 相邻项目 | 是，coding workflow harness | 未见公开支持 | 每次 workflow 独立 git worktree，不是每用户 runtime | 项目/用户级 workflow；未见多租户管理员分发面 | 未见公开支持 | 是，但当前更像单用户/团队工作流引擎 |

## 直接替代品

### 1. dshcloud：平台化程度最高的 DSH-native 直接替代品

`dshcloud` 官方将自己定义为 DeepSeek Harness 的自托管多用户平台。管理员通过邀请链接增加用户，每个用户可以在配额内创建多个 workspace。每个 workspace 是独立容器，带独立持久化目录、CPU/内存/进程数/磁盘配额、独立子域入口，并支持启动、停止、重建、升级和回滚前快照。

它比当前 `dsh-multiuser` 更强的方面：

- 容器级 workspace 隔离，而不只是同一主机上的独立 Node 进程和目录。
- 一名用户可以创建多个 workspace，并由管理员统一限制数量与资源。
- 管理员统一维护 DSH 镜像版本、默认版本、预热、升级和实例舰队状态。
- Linux 上使用 XFS project quota 强制字节与 inode 上限。

它没有替代本项目全部差异点：

- README 和架构文档只说明邀请用户与平台会话，本次未见 OIDC/SAML SSO 支持。
- 管理面覆盖用户、配额、实例和镜像版本，本次未见管理员统一下发模型、Skill、插件和 MCP，也未见公共配置与用户私有 Profile 合并。
- README 明确标为 early development、not production-ready；架构文档列出容器仍以 root 运行、未 drop capabilities、未设置 `no-new-privileges`、无 egress 限制等残余风险。
- 截至访问日，官方还未验证完整的 workspace 创建/访问、实例证书、宿主重启恢复等真实部署链路。

判断：若用户需要“多 workspace、容器和资源配额”，`dshcloud` 是当前最强的 DSH-native 直接竞品；若用户更重视外部 IdP JWT 接入与 DSH 公共资源分发，本项目仍有不同价值。

官方来源（均访问于 2026-09-15）：

- [dshcloud GitHub 仓库与 README](https://github.com/eskim2001/dshcloud)
- [架构、隔离模型、残余风险与验证状态](https://github.com/eskim2001/dshcloud/blob/main/docs/ARCHITECTURE.md)

### 2. dsh-server-deployment：运行模型与安全边界最接近

`dsh-server-deployment` 是服务器端多用户网关。每个用户拥有独立 DSH 实例、端口、Linux 系统账号 `dsh-<name>`、0700 `DSH_HOME` 和 0600 API Key 文件；网关通过 systemd 管理实例。文件助手由固定 sudoers 白名单进入 root 后立即用 `runuser` 降到目标用户，网关账号本身无权读取用户目录。

它还针对同机回环攻击设置 iptables owner guard，限制每个 uid 只能连接自己的 DSH 端口；README 明确指出所有租户共享的 DSH 安装树必须对 group/other 不可写，避免共享代码或 Skill 被篡改后跨租户执行。

与当前项目相比：

- 优势是 OS UID/GID 构成更清楚的文件权限边界，并补了回环端口的 uid 级限制。
- 同样采用每用户一个原版 DSH 实例，是架构上最直接的替代方案之一。
- 认证是自建本地账号，本次未见 OIDC/SAML 或外部 IdP JWT 接入。
- 管理面集中于建号、改密、删号、预置 Key 和文件交付，本次未见统一模型、Skill、插件、MCP 及公共/私有配置合并。

官方来源（均访问于 2026-09-15）：

- [dsh-server-deployment GitHub 仓库与 README](https://github.com/AnkoCD/dsh-server-deployment)
- [多用户隔离说明](https://github.com/AnkoCD/dsh-server-deployment/blob/main/docs/multi-user-isolation.md)

### 3. dsh-hub：JupyterHub 风格的轻量直接替代品

`dsh-hub` 使用 Linux PAM 登录，并为每个系统用户启动一个独立 DSH 实例。实例以用户自己的 uid/gid 运行，使用独立 `~/.dsh`、随机回环端口和每用户日志；iptables `--uid-owner` 规则阻止本机用户连接其他人的 DSH 端口。用户自己的插件安装继续保留。

这一路线比本项目更依赖 Linux 主机账号和 root/systemd：非 root 启动会退化为没有 setuid 和 iptables 的单用户语义。它没有文档化 OIDC/SAML，也没有管理员统一分发模型、Skill、插件或 MCP；PAM 可以接入主机认证体系，但不能直接等同于应用层企业 SSO。

判断：若需求是“最少组件地把 Linux 账号映射为独立 DSH”，它比本项目更直接；若需求包含 IdP SSO、应用内账号生命周期和公共资源模板，本项目覆盖面更大。

官方来源（均访问于 2026-09-15）：

- [dsh-hub GitHub 仓库与 README](https://github.com/Mpaperlee/dsh-hub)

### 4. Coder Agents：最接近的通用开源替代品

Coder 官方将其定义为“Self-Hosted Cloud Development Environments and AI Agents”。Coder Agents 是用 Go 实现的原生 agent，agent loop 位于 Coder control plane，文件读写和命令执行通过既有连接进入 workspace。它不是 Claude Code 或 Codex 的包装层。

与 `dsh-multiuser` 重合的能力：

- 多用户：Coder 本身拥有用户、组织、角色和 workspace 所有权；官方文档明确称 agent 只能访问发起用户拥有的 workspace，不能跨用户访问。
- SSO：Community 部署文档提供通用 OIDC 配置，可连接 Okta、Active Directory 等 IdP；密码登录也可关闭。
- 独立执行环境：需要代码操作时自动为用户选择模板并创建 workspace。workspace 可以由 Terraform 定义为 VM、Kubernetes Pod 或 Docker 容器。
- 集中模型：平台管理员管理 provider 和凭据，模型按组织管理并通过 ACL 分发；模型密钥不进入 workspace。
- 集中治理：管理员可设置全局 system prompt；组织管理员可配置 MCP Server、ACL、工具白名单/黑名单，MCP 还支持每用户 OAuth/OIDC 身份。
- Skill：workspace 中的 `.agents/skills/` 可由模板/代码仓库提供，用户另有 Personal Skills。
- 开源/自托管：主仓库采用 AGPL-3.0，可直接自托管；官方同时说明 Community License 最多并发运行 5 个 agent，更多并发与 Agent Hours 属于 Premium 模式。

不能视为完全相同：

- 它运行 Coder 自己的 agent loop，不运行 DeepSeek Harness，也不消费 DSH Profile、Cordis Bundle 或 DSH 插件。
- agent loop 是共享控制面的服务，每用户隔离主要由 workspace 及 Coder 权限模型承担，不是每用户一个完整 Harness 进程和 `DSH_HOME`。
- Coder 的集中扩展面主要是 workspace template、Skill 和 MCP；没有与 DSH 公共插件/Profile 合并完全等价的概念。
- Coder 是完整 CDE 平台，部署和运维体量显著大于当前单机 `dsh-multiuser`。

判断：若用户只需要“企业内部多人使用自托管 coding agent”，Coder Agents 已足以构成直接竞争；若用户已经选择 DSH、需要 DSH 插件生态及较轻量的单机入口，它不能无迁移替代。

官方来源（均访问于 2026-09-15）：

- [Coder GitHub 仓库与 AGPL License](https://github.com/coder/coder)
- [Coder Agents 概览](https://coder.com/docs/ai-coder/agents)
- [Coder Agents 架构与 workspace 隔离](https://coder.com/docs/ai-coder/agents/architecture)
- [Coder Agents 快速开始、集中 system prompt 与 Community 并发限制](https://coder.com/docs/ai-coder/agents/getting-started)
- [集中模型与组织 ACL](https://coder.com/docs/ai-coder/agents/models)
- [Skill 与 workspace MCP](https://coder.com/docs/ai-coder/agents/extending-agents)
- [管理员 MCP 与每用户 OAuth/OIDC](https://coder.com/docs/ai-coder/agents/platform-controls/mcp-servers)
- [OIDC 登录](https://coder.com/docs/admin/users/oidc-auth)
- [管理员 workspace templates](https://coder.com/docs/admin/templates/managing-templates)

### 5. OpenHands：完整能力存在，但关键部分是商业版

OpenHands 现在的开源入口 Agent Canvas 是 coding-agent 控制中心，可运行 OpenHands、Claude Code、Codex、Gemini 或其他 ACP agent，并连接本地、Docker、VM 或云端后端。其开源能力与 DSH 在 Agent Profile、LLM Profile、Skill、MCP、插件及自托管方面重合。

但是官方的 Enterprise vs. Open Source 表给出了清晰边界：

- Agent Canvas 的本地/VM 开源后端没有 Authentication & authorization、RBAC、Multi-user organizations、Enforce default LLMs。
- 开源本地后端没有 isolated sandboxes；VM 隔离仍标为 roadmap。
- SAML、custom runtime images、组织级插件市场属于商业 OpenHands Enterprise。
- Enterprise 可为 conversation 选择独立 sandbox，也可让多个 conversation 共享 sandbox；官方特别说明共享 sandbox 的会话共享文件、凭据、计算和故障域。
- Enterprise 支持组织 Skill repository、用户 Skill repository、conversation plugin、组织/用户 Marketplace 和 Auto-Load。

判断：OpenHands Enterprise 是产品层面的直接替代品，但不是“相同能力的开源项目”。开源 Agent Canvas 更适合个人或小团队共同使用后端，不满足当前项目的认证隔离目标。

官方来源（均访问于 2026-09-15）：

- [OpenHands GitHub 仓库](https://github.com/OpenHands/OpenHands)
- [Enterprise 与开源版功能对照](https://docs.openhands.dev/enterprise/enterprise-vs-oss)
- [Enterprise Conversation 与 Sandbox](https://docs.openhands.dev/enterprise/conversations-and-sandboxes)
- [Enterprise Skill 与 Plugin 分发](https://docs.openhands.dev/enterprise/skills-and-plugins)
- [Enterprise SAML SSO](https://docs.openhands.dev/enterprise/integrations/saml-sso)
- [Enterprise Plugin Marketplace](https://docs.openhands.dev/enterprise/plugin-marketplace)
- [开源 Agent Profile](https://docs.openhands.dev/openhands/usage/agent-canvas/agent-profiles)

## 部分替代品

### 6. dsh-passwords：单 DSH 上的账号、权限与配额层

`dsh-passwords` 是直接安装到 DSH 的多租户插件。首次配置创建主用户，主用户可在 DSH 设置页创建子用户，并为其配置工作区白名单、逐会话授权、每小时 token 上限、每日使用时长、沙箱档位、上传下载和 WebSocket 路径权限。它还提供运维视图、自动 TLS 及 Docker/本机安装流程。

它与“每用户 Runtime”路线有本质区别：

- 所有账号使用同一个 DSH 部署；隔离由插件的工作区/会话授权和网关请求门控实现，不是进程、OS uid 或容器边界。
- 主用户统一管理的是用户可访问的现有工作区、会话和配额，不是向各自 Runtime 分发公共 Profile、Skill、插件或 MCP。
- README 未声明 OIDC/SAML SSO。

判断：若目标是以最低部署成本共享一个 DSH，并对可信子用户做权限和配额管理，它可能比本项目更合适；若要求用户运行环境、凭据和插件真正分开，则不能直接替代。

官方来源（均访问于 2026-09-15）：

- [dsh-passwords GitHub 仓库与 README](https://github.com/slywalker2006/dsh-passwords)

### 7. dsh-login：单进程会话隔离，启动组合尚未验收

`dsh-login` 为 DSH Web GUI 增加本地账号、管理员界面、会话归属、方法 allow-list、事件流过滤和每用户名目录下的默认 workspace。普通用户被限制到自己的会话及其子 agent/fork，并禁止 credentials、settings、agent presets 和主机目录选择等特权接口。

但其官方 README 对当前状态给出了关键限制：适配 DSH 0.1.5 后，per-user isolation 被迁移为 `wrapRemoteGateway` / `createRemoteIsolation` REMOTE-layer guard；发布包提供这个组合原语，**仍需部署在启动时覆盖 `typertGateway`，并完成双浏览器行为验收，shipped patch 本身尚未强制执行它**。因此单元/集成测试通过不能替代真实启动后的跨用户隔离证明。

此外，它仍是单 DSH 进程和单个上层 `DSH_HOME` 数据体系；默认 workspace 只是 `workspaceRoot/<username>` 下的目录与归属记录，不是每用户独立 Runtime。README 也明确说明 DSH 的全局 settings section、exact route 和客户端插件激活缺少身份维度，第三方插件无法普遍按用户隐藏或阻断。

判断：这是最接近“直接给现有 DSH 加登录”的插件竞品，但当前不能把其 per-user guard 宣称为 boot-verified 的完整隔离方案。

官方来源（均访问于 2026-09-15）：

- [dsh-login GitHub 仓库与 README](https://github.com/islibaodong/dsh-login)
- [Option A 启动验证清单](https://github.com/islibaodong/dsh-login/blob/master/docs/verify-option-A.md)

### 8. LibreChat：功能快速接近，但 coding workspace 仍是实验能力

LibreChat 是完全自托管的多用户 Agent/聊天平台。官方仓库当前列出的能力包括 OAuth2、LDAP 和邮件登录，Agent、MCP、Skill、Agent Plugin、管理员面板，以及 Managed/Personal Attached Code Workspaces。其 workspace 可以让 Agent 浏览、修改文件和执行 Bash，并支持代码操作审批。

它与本项目的差别是：

- 官方将 Attached Code Workspaces 标为 **highly experimental**，不宜据此承诺生产级每用户执行隔离。
- workspace 是绑定到 Agent 的 managed/personal worker，而非每个登录用户启动一个完整且持久的 DSH Runtime。
- LibreChat 的重点仍是跨模型聊天与通用 Agent，代码开发只是其中一类工具能力。
- 它不兼容 DSH Profile、Bundle 和 Cordis 插件；“Agent Plugin”是 LibreChat 自己的 Skill + MCP 打包机制。

判断：对于“给团队一个带 MCP 和代码执行的统一 AI 门户”，LibreChat 可能替代本项目；对于“把完整 DSH 体验按用户运行并保留私有/公共插件层”，目前不能直接替代。

官方来源（均访问于 2026-09-15）：

- [LibreChat GitHub 仓库与功能清单](https://github.com/danny-avila/LibreChat)
- [认证配置](https://www.librechat.ai/docs/configuration/authentication)
- [MCP、多用户凭据及运行时添加](https://www.librechat.ai/docs/features/mcp)

## 相邻项目

### 9. WebDSH：覆盖面接近，但目前主要是设计方案

`WebDSH` 的目标与本项目高度重合：不 fork DSH，通过 overlay 增加认证前门、每用户独立进程与 `DSH_HOME`、workspace ACL、审计和配额；还设计了共享仓库、个人/共享分支和 Codeup 凭据绑定。

不过官方 README 的目录说明明确写道“实施阶段开始后”才会新增 `gate/` 和 `plugin/` 源码；当前仓库主体是现状分析、目标架构、安全设计、实施计划和 Phase 0 记录。因此它可用来比较需求与架构选择，不能按已可部署产品与其他项目等量评价。

官方来源（均访问于 2026-09-15）：

- [WebDSH GitHub 仓库、设计目标与当前目录状态](https://github.com/darker2016/WebDSH)

### 10. Open WebUI：成熟的多用户 AI 门户，不是同类 Harness

Open WebUI 的开源核心支持自托管、RBAC、用户组、模型/Agent、Tools、Skills、MCP 和访问控制。它适合作为统一模型与工具入口，但主产品不是代码仓库内工作的 coding-agent harness。

官方 README 将“每用户隔离容器、独立凭据、资源限制和网络规则”归到 **Terminals (Enterprise)**；开源的 Open Terminal/Computer 是可连接的执行组件，但没有在核心开源项目中形成与 `dsh-multiuser` 等价的每用户 DSH Runtime 生命周期。因此它主要竞争管理员门户、认证和公共资源管理，而不是 DSH 执行面。

官方来源（均访问于 2026-09-15）：

- [Open WebUI GitHub 仓库、功能与生态边界](https://github.com/open-webui/open-webui)
- [Open WebUI 官方文档](https://docs.openwebui.com/)
- [Open Terminal GitHub 仓库](https://github.com/open-webui/open-terminal)

### 11. Archon：同为 coding harness，但缺少多用户控制面

Archon 是开源的 AI coding workflow engine，用 YAML 固化计划、实现、验证、评审和创建 PR 等步骤。每次 workflow run 使用独立 git worktree，支持 CLI、Web UI、Slack、Telegram 和 GitHub。

它解决的是“编码工作流可重复”和“任务并行不冲突”，而不是“为企业用户提供身份、SSO、每用户 runtime 和管理员公共资源分发”。本次查阅的官方 README 未见多用户账号、SSO、每用户配置隔离或管理员模型/Skill/MCP 分发的公开承诺。

判断：Archon 可作为 DSH 上层 workflow 思路或竞品参考，但不是当前多用户插件的替代品。

官方来源（均访问于 2026-09-15）：

- [Archon GitHub 仓库与官方 README](https://github.com/coleam00/Archon)
- [Archon 官方文档](https://archon.diy/docs/)

## 对 `dsh-multiuser` 开源定位的建议

### 值得继续开源的条件

项目应明确服务以下人群：已经采用或评估 DeepSeek Harness，希望在单台受控主机上以较低成本为可信内部用户提供独立 DSH Runtime，并由管理员统一下发 DSH 模型、Skill、插件和 MCP。

建议公开表述的差异点：

- **DSH-native**：执行的是原版 DSH Profile 和 Bundle，不是另写一个 agent loop。
- **每用户完整 Runtime**：独立进程、`DSH_HOME`、workspace、日志和缓存，而不只是数据库中的用户记录或聊天会话。
- **公共资源与私有资源合并**：公共模型、Skill、插件和 MCP 在启动时进入用户 Profile，同时保留用户私有依赖与配置。
- **轻量单机部署**：面向小团队和可信内部用户，明确不宣称恶意租户级 OS 沙箱。
- **可学习的参考实现**：展示如何把单用户 Harness 产品化为带认证、路由、生命周期和资源治理的多人服务。

### 不值得继续投入的定位

如果目标是独立发展成与 Coder/OpenHands Enterprise 正面竞争的通用企业 AI 编码平台，则当前项目缺少 Kubernetes/VM 沙箱、强租户隔离、RBAC/组织、审计治理、弹性调度、成熟 IdP 集成和长期运维能力。补齐这些能力会把一个 DSH 插件控制面扩张为完整平台，投入与差异化不匹配。

### 推荐决策

继续开源，但把范围冻结在“DSH 多用户参考实现/轻量控制面”，不要把路线图扩张成通用 CDE 或企业 Agent 平台。README 应优先加入与 `dshcloud`、`dsh-server-deployment`、`dsh-hub`、`dsh-passwords` 和 `dsh-login` 的差异，再补充与 Coder Agents、OpenHands 的边界，并明确适用规模、信任模型和不支持项。这样项目的价值来自 DSH 公共资源治理、外部 IdP JWT 接入和实现透明度，而不是声称市场上不存在类似产品。
