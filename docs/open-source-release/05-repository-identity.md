# 仓库身份与发布主体

状态：四项决策已确定、占位符已替换（2026-09-17）；仓库创建、PVR 启用与 npm 账号注册待执行
对象：首次公开发布 `dsh-multiuser` 的维护者
前置：第 1 章、第 2 章完成

本文解决发布前唯一无法由代码或测试替代的阻塞项：**这套软件对外用什么身份出现**。它包含四项决策，其中三项决定文档和元数据内容，一项只决定操作位置。

## 为什么这一步会卡住整个发布

`package.json` 的仓库地址、`SECURITY.md` 的漏洞报告链接、所有安装命令里的包名，都依赖这两项取值。它们不定下来：

- 第 4 章的验收命令无法执行（`npx <包名>@0.1.0` 不知道该写什么）。
- CI 无法从干净 checkout 复现 tarball 安装。
- 文档里所有 `@<所有者>/dsh-multiuser` 引用无法收敛成可复制的命令。

因此本文必须排在第 3 章（生产部署）之前完成——部署手册的每一步都直接抄写这些命令。

## 四项决策

### 决策 1：GitHub owner（仓库所有者）

**是什么**：仓库地址 `github.com/<这段>/dsh-multiuser` 里的 `<这段>`。它是**用户名**，不是你在 GitHub 上显示的昵称。

**怎么查**（任选一种）：

1. 打开自己任意一个仓库，浏览器地址栏 `github.com/` 之后到下一个 `/` 之间的字符串。
2. 访问 `github.com/settings/profile`，页面上的 `Username` 字段。
3. 点右上角头像 → `Your profile`，地址栏同上。

**本项目取值**：`xuegaotian`

**影响范围**：`package.json` 的 `repository` / `bugs` / `homepage` 三个字段，以及 `SECURITY.md` 的漏洞报告链接。

**注意**：如果你后续要把仓库转到组织（例如 `MagePY27`）下，owner 就变成组织名，本文替换脚本需要以组织名重跑一次。个人账号下发布更简单，建议首个版本就用个人账号。

### 决策 2：npm 包名

两个选项，代价不同：

| | 无 scope | scoped |
|---|---|---|
| 取值 | `dsh-multiuser` | `@<npm 用户名或组织>/dsh-multiuser` |
| 现状 | **实测未被占用**（2026-09-17 `npm view dsh-multiuser` 返回 404） | scope 名必须在 npm 上先存在 |
| 好处 | 命令短；要改的文件最少；`package.json` 的 `name` 不用动 | 命名空间独占，永不与别人撞名 |
| 代价 | 名字通用，不绑定你的账号 | 必须改 `package.json` 的 `name`；个人 scope 默认私有，必须有 `publishConfig.access: "public"` 才能公开；`test/install-pack.integration.test.ts` 里硬编码的 `node_modules/dsh-multiuser` 必须同步改成 `node_modules/@<scope>/dsh-multiuser` |

**推荐**：无 scope `dsh-multiuser`。名字干净且未被占用，替换脚本只动文档和 URL，不碰包结构。

**注意**：GitHub 用户名与 npm 用户名是两套独立账号，可以不同。无 scope 方案下两者互不影响。

### 决策 3：安全漏洞联系方式

**推荐**：只用 GitHub Private Vulnerability Reporting，`SECURITY.md` 里不写邮箱。

理由：公共仓库自带该功能，报告者通过 GitHub 私密提交，你不需要公开任何邮箱，且 GitHub Security Advisory / OSV 生态直接认这个通道。

**启用位置**：仓库 → `Settings` → 左侧 `Security` → `Code security` 区域 → `Private vulnerability reporting` → `Enable`。**只在仓库创建后才有这个开关**，所以本决策在执行顺序上排在建仓库之后。

**不要用工作邮箱**：如果项目与雇主相关，把公司邮箱写进个人开源项目的安全通道，一是你离职后通道失效，二是可能被解读为公司背书。若确实要用邮箱，用一个你能长期持有的个人地址。

### 决策 4：版权主体

`LICENSE` 当前为：

```text
Copyright (c) 2026 dsh-multiuser contributors
```

**这个写法完全合法，是 GitHub 新建仓库的默认模板措辞**，不影响 MIT 授权效力，也不需要披露真名。如果不想在法律文件里出现个人信息，**保持原样即可，不用改**。

三种可选写法：

| 写法 | 适用情形 |
|---|---|
| `dsh-multiuser contributors`（当前） | 不想披露真名；个人项目；预期后续会有外部贡献者 |
| 个人真名或 GitHub 用户名 | 希望明确归属到个人 |
| 公司主体 | 公司正式开源该项目 |

**必须判断的前提**：如果这些代码是你在工作时间、使用公司设备或为公司的多用户 DSH 需求开发的，它可能构成**职务作品**，著作权归公司，此时你个人无权以 MIT 对外授权。这种情况下先把归属跟公司确认清楚，再决定版权主体和用哪个邮箱——这两件事是绑定的。

## 执行步骤

### 步骤 1：确认四项取值

```text
GitHub owner : xuegaotian
npm 包名      : dsh-multiuser            # 或 @<scope>/dsh-multiuser
安全联系      : GitHub PVR（仓库建好后开启）
版权主体      : 保持 dsh-multiuser contributors（或按决策 4 改成实际主体）
```

### 步骤 2：运行替换脚本

先看会改什么（不写文件）：

```sh
scripts/set-repository-identity.sh --github-owner xuegaotian --dry-run
```

确认 diff 无误后写入：

```sh
scripts/set-repository-identity.sh --github-owner xuegaotian
```

若选 scoped 包名，加 `--npm-scope`：

```sh
scripts/set-repository-identity.sh --github-owner xuegaotian --npm-scope <你的npm用户名>
```

脚本会：备份所有被改动的文件到临时目录（路径会打印）、替换占位符、扫描全仓确认占位符已清零。

**脚本的行为边界（重要）**：它只替换**真实引用**——包名用法和 GitHub URL。对于把占位符当作**概念**来提及的地方（"待确定"的待办描述、门禁检查命令），它刻意不动：把检查命令里的占位符换成真实用户名，会让那条命令从"检查占位符是否清零"变成"搜索你自己的用户名"，从此永远误报。这类文字由步骤 3 手工改写。

### 步骤 3：校验

替换后手工确认三件事：

```sh
# 1. 占位符清零（脚本已自动检查，这里是复核）
grep -rn "<owner>" package.json SECURITY.md docs README.md || echo "清零确认"

# 2. package.json 的仓库地址正确
node -p "require('./package.json').repository.url"

# 3. 类型检查与测试仍然通过
NODE_OPTIONS= pnpm typecheck && NODE_OPTIONS= pnpm test
```

以下是本次已经手工改写的**描述性文字**。脚本刻意不碰这类句子，因为它们把占位符当作概念提及而不是引用；将来更换 owner 重跑脚本时，这些位置需要同样处理：

| 文件 | 位置 | 改写内容 |
| --- | --- | --- |
| `docs/open-source-release/README.md` | 状态行 | 第 5 章列入已完成，删去"占位符待确定" |
| `docs/open-source-release/README.md` | 第 2 章第一条 | 勾选并写明取值：无 scope 包名 + 真实仓库地址 |
| `docs/open-source-release/README.md` | 第 8 条 | 改为"已替换；PVR 待仓库创建后启用" |
| `docs/open-source-release/02-installation-packaging.md` | 状态行 | 改为"已实施"并写明取值 |
| `docs/open-source-release/02-installation-packaging.md` | 第一阶段 | 四条步骤改写为已完成记录 |
| `docs/open-source-release/03-production-deployment.md` | 占位符说明表 | 删除所有者那一行（占位符已不存在） |
| `docs/open-source-release/04-release-validation.md` | 第一关 | 检查命令加 `--glob` 排除自指文件，并说明原因 |

### 步骤 4：在 GitHub 建仓库

1. 打开 `https://github.com/new`。
2. `Repository name` 填 `dsh-multiuser`。
3. 可见性选 `Public`。
4. **不要勾选** `Add a README file` / `Add .gitignore` / `Choose a license`——本地已经有这些文件，勾了会产生冲突。
5. 点 `Create repository`。
6. 页面会显示推送命令。回到本地执行（推送前先完成步骤 2 的替换并提交）：

```sh
git add -A
git commit -m "Add compatibility matrix, installer, backup/restore and release handbook"
git branch -M main
git remote add origin https://github.com/xuegaotian/dsh-multiuser.git
git push -u origin main
```

**成功信号**：`git remote -v` 能列出 origin，`git push` 后仓库页面能看到文件，且 `.github/workflows/ci.yml` 被 GitHub 识别为 Actions 工作流。

**注意**：首次推送后 CI 会立刻开跑。当前工作区已覆盖 Node `22.19.0` 和 `24`，tarball 测试会传入 `DSH_PACK_DIR`，`package.json` 与 `pnpm/action-setup` 均固定 `pnpm@11.23.0`。仍应以 GitHub Actions 的首次真实运行结果为准；若失败，先定位具体作业和日志再修改。

### 步骤 5：开启 Private Vulnerability Reporting

仓库 → `Settings` → `Security` → `Private vulnerability reporting` → `Enable`。

**成功信号**：`https://github.com/xuegaotian/dsh-multiuser/security/advisories/new` 打开后是可提交的报告表单，而不是 404。

### 步骤 6：准备 npm 发布账号

1. 到 `https://www.npmjs.com/signup` 注册。**用户名一旦注册不可更改**，且会出现在包的公开页面上，取一个能与 GitHub 关联的名字。
2. 本地登录并确认身份：

```sh
npm login
npm whoami
```

3. 无 scope 方案下，发布前确认包名仍未被占用：

```sh
npm view dsh-multiuser name version
```

返回 404 表示可用；返回版本号表示已被占用，此时必须改成 scoped 包名。

**注意**：npm 发布强制要求双因素认证（2FA）。在 `npmjs.com/settings/<用户名>/profile` 里开启，并保存好恢复码。没有开启 2FA 时 `npm publish` 会直接被拒绝。

### 步骤 7：更新手册状态

- 本章开头的状态改为"已完成"，写明确切的取值和完成日期。
- `docs/open-source-release/README.md` 的状态行同步更新。
- 在 `release-evidence/` 建立首个版本的记录文件，记下：commit、Node/pnpm/DSH 版本、上述命令的实际输出、四条决策的取值。

## 验收标准

2026-09-17 执行状态：

- [x] 仓库内无占位符残留，例外只有下方豁免清单里的 3 个文件。
- [x] `node -p "require('./package.json').repository.url"` → `https://github.com/xuegaotian/dsh-multiuser.git`。
- [x] `NODE_OPTIONS= pnpm typecheck` 与 `NODE_OPTIONS= pnpm test` 替换后仍通过。2026-09-17 最终验证：类型检查退出码 0，`pnpm test` 为 126 passed / 15 skipped（14 个测试文件通过、3 个集成文件与 1 个 dotted-loopback 环境用例按预期跳过；集成测试单独执行为 11/11 通过、tarball 测试 3/3 通过）。
- [ ] `npm view dsh-multiuser name version` 返回 404（包名可用）。2026-09-17 两次实测为 404，发布前需复测。
- [ ] GitHub 上 `git remote -v` 的 origin 指向真实仓库，且 `main` 分支已推送。
- [ ] `.../security/advisories/new` 可打开报告表单。
- [ ] `SECURITY.md` 中的报告链接指向真实仓库，且不包含个人或公司邮箱（若按决策 3 选择只使用 PVR）。
- [ ] `LICENSE` 的版权主体已经过"是否职务作品"的判断，不是默认保留。

## 豁免清单

以下 3 个文件按设计保留占位符字样，任何占位符扫描都必须排除它们，否则自指的命令会永远误报：

| 文件 | 保留原因 |
| --- | --- |
| `docs/open-source-release/04-release-validation.md` | 第一关门禁命令的模式本身 |
| `docs/open-source-release/05-repository-identity.md` | 本文件，含同类复核命令 |
| `scripts/set-repository-identity.sh` | 替换工具自身，注释与检查逻辑含该字样 |

复核命令用 Node 做精确匹配，避免 shell 对尖括号的转义问题：

```sh
node -e 'const {readdirSync,readFileSync}=require("fs"),{join,relative}=require("path");const skip=new Set([".git","node_modules","compat-work","compat-work-alpha","dist",".workbuddy"]);const hits=[];(function w(d){for(const e of readdirSync(d,{withFileTypes:true})){if(skip.has(e.name))continue;const p=join(d,e.name);if(e.isDirectory()){w(p)}else if(readFileSync(p,"utf8").includes("<owner>")){hits.push(relative(process.cwd(),p))}}})(process.cwd());console.log(hits.join("\n")||"（无残留）")'
```

## 常见错误

- **把昵称当用户名**：昵称可以随时改、可以重复，URL 里用不了。只有 Settings 页面上的 `Username` 才是。
- **建仓库时勾选了初始化选项**：会与本地已有文件冲突，push 被拒。删掉远程仓库重建即可。
- **scoped 包发布失败**：个人 scope 默认私有，必须有 `publishConfig.access: "public"`。本项目已有该字段。
- **改完包名忘了改测试**：`test/install-pack.integration.test.ts` 里硬编码了安装后的包目录路径，scoped 方案下不同步会直接测试失败。
- **直接用开发目录验证**：所有验证必须走 `npm pack` 产物的 tarball，从空目录安装，否则会因为相邻 checkout 而假通过。
