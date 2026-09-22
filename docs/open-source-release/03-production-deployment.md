# 生产部署

状态：待在新主机完整执行验证  
首个支持目标：Linux、systemd、单机、HTTPS 反向代理、可信内部用户。

## 占位符与验证状态说明

本手册使用尖括号占位符表示必须由维护者替换的内容。所有形如 `<...>` 的标记在真实部署前都必须替换为实际值，不得原样执行：

- `<网关域名>`：对外访问的 HTTPS 主机名，例如 `dsh.example.com`。
- `<DSH 精确版本>`：`compatibility.json` 中 `testedDshVersions` 列出的已测版本，例如 `0.1.5-rc.1`。**这是 `@deepseek-ai/dsh` 的版本，只用于 `npm install --global @deepseek-ai/dsh@<DSH 精确版本>`。**
- `<应用版本>`：`package.json` 的 `version`（写作时为 `0.1.0`）。**这是 `dsh-multiuser` 自身发布包的版本，与 `<DSH 精确版本>` 是两个不同的东西。** 安装 dsh-multiuser 时必须写成 `dsh-multiuser@<应用版本>`；写错成 DSH 的版本会 404。升级/重装目标用 `<新应用版本>`，回滚目标用 `<旧应用版本>`——两者是同一个包的不同发布版本，但**回滚的 `<旧应用版本>` 必须与升级前数据备份的 Schema 版本对齐**（高危操作，填错会导致旧二进制打不开新 Schema）。
- `<dsh 可执行路径>`：全局安装的 `dsh` 二进制绝对路径，例如 `/usr/bin/dsh`。
- `<IdP issuer>` / `<IdP audience>` / `<IdP origin>`：可信 IdP 的 issuer、audience 与精确 origin。
- `<SSO kid>` / `<SSO 公钥路径>`：SSO 公钥的 key id 与 PEM 文件绝对路径。
- `<证书全链路径>` / `<私钥路径>`：TLS 证书与私钥绝对路径。
- `<备份目录>`：备份产物写入的绝对目录，必须按密钥材料保管。
- `<操作系统版本>` / `<Node 版本>`：目标主机的实际操作系统与 Node 版本。

下面「验证状态」表中的每一项都必须在本手册于一台**全新 Linux 虚拟机**上完整执行通过后，才可从 `未验证` 改为已验证。手册当前未验证，因此「完成标准」全部保持未勾选。

| 章节 | 验证状态 | 说明 |
| --- | --- | --- |
| 支持边界与非目标 | 未验证 | 基于 README 与代码核对，未经新主机执行 |
| 部署前提与前置检查 | 未验证 | 命令语义已在 macOS 验证（非生产拓扑），精确版本待维护者替换 |
| 目录、服务账号与权限 | 未验证 | 布局以 `install.ts` 代码为准，未经新主机执行 |
| 安装锁定的 DSH | 未验证 | `npm install -g` 语义已在 macOS 验证；精确版本待替换 |
| 安装 dsh-multiuser（systemd） | 已在 macOS 上验证单元/环境文件/keys 落盘与内容 | `--system-root` 演练已实测：单元直接落盘、env 首次创建 0600、keys 0750、`bin/dsh-multiuser` 软链可用；root 安装、`useradd` 与 `systemctl` 行为待真实主机 |
| 初始化管理员 | 已在 macOS 上验证命令语义（非生产拓扑） | `init-admin` 在 tarball 产物实测（见第 2 章），并已修正数据库权限为 0600；systemd 下以服务账号运行待真实主机 |
| 配置 SSO 公钥 | 未验证 | 依赖真实 IdP 值 |
| 配置 HTTPS 反向代理 | 未验证 | Nginx 模板当前不在 `deploy/`，仅在手册内，必须在真实域名与证书上验证后才进入 `deploy/` |
| systemd 启动验收 | 未验证 | 单元内容已实测（含 `--allowed-host` 在续行链内、`deploy/` 样例与生成器逐指令一致），真实 `systemctl enable --now` 待主机 |
| 健康与就绪探针 | 已在 macOS 上对真实网关端到端验证 | `/healthz`、`/readyz`（DB/PROFILE_TEMPLATE/DSH_VERSION 三项 checks）、`/version` 均返回 200，伪造 Host 返回 421；`status` 读三端点并返回正确退出码。反向代理链路与 TLS 待新主机 |
| 首次功能验收 | 未验证 | 由第 4 章第七关在新主机执行 |
| 备份与恢复 | 已在 macOS 上端到端验证 | 实测链路：`backup`（含 `gateway.env` 共享模型配置）→ 删除数据根/数据库/模型配置 → `restore` → 重启网关，`/readyz` 200、用户工作区文件可见、`/admin/global-config` 返回 `apiKeyConfigured:true`。停机窗口与真实主机待验证 |
| 升级与回滚 | 未验证 | Schema 不可降级说明已写入，回滚用 `restore` 恢复升级前数据，流程待真实主机验证 |
| 卸载 | 已在 macOS 上验证命令语义（非生产拓扑） | `uninstall` 保留数据实测（见第 2 章）；systemd 流程待真实主机 |

## 支持边界与非目标

首个公开版本不应宣称支持 Kubernetes、Windows 生产部署、多节点调度、高可用、水平扩容或恶意租户隔离。每名用户虽有独立进程和目录，但 Runtime 仍以同一服务账号运行，也没有独立 CPU、内存、磁盘和出站网络限制。

对不可完全信任的用户，应选择每用户 OS UID、容器或虚拟机的部署方案，不得仅靠本项目的目录分配宣称安全隔离。

## 部署前提与前置检查

准备一台全新的 Linux 虚拟机执行首次验收，不要在已有生产数据的主机上试写本手册。

需要：

- Node.js `^22.19.0 || >=24.0.0`。
- 已锁定且通过兼容矩阵的 `@deepseek-ai/dsh`（版本取自 `compatibility.json`）。
- systemd。
- Nginx、Caddy 或其他能正确代理 HTTP 和 WebSocket 的 HTTPS 入口。
- 可信 IdP 的 Ed25519 公钥、issuer、audience 和精确 origin。
- 用于验收的两个普通用户身份。

前置检查（在目标主机执行）：

```sh
node --version
dsh --version
systemctl --version
curl --version
openssl version
```

成功信号：

- `node --version` 输出 `v22.19.0` 及以上，或 `v24.x` 及以上。
- `dsh --version` 输出一个出现在 `compatibility.json` 的 `testedDshVersions` 中的版本。
- `systemctl --version` 正常输出，且为初始化的 systemd 系统。

失败恢复：

- Node 版本不符：安装符合 `^22.19.0 || >=24.0.0` 的 Node（用 `nvm`/系统包），重跑 `node --version`。
- `dsh: command not found` 或版本不在兼容矩阵：先完成「安装锁定的 DSH」，再回此处。
- 无 systemd：本手册的 systemd 流程不适用，需改用等价进程管理器（不在首个支持目标内）。

## 目录、服务账号与权限

目录布局以 `install.ts` 的代码为准，不使用软链 `current/` 布局。约定如下：

```text
/opt/dsh-multiuser/                  # 应用目录（--app-dir，不可变应用文件）
  bin/dsh-multiuser                  # 应用入口，install 创建
  dist/src/                          # 编译后的 Gateway 与 CLI
  profiles/user-runtime/             # 随包发布的 Profile 模板
  packages/bundle/user-runtime/      # 随包发布的 Runtime Bundle
/var/lib/dsh-multiuser/              # 数据目录（--data-dir，持久可变）
  gateway.sqlite                     # 账号、会话、审计、Runtime 控制状态
  gateway.sqlite-wal
  gateway.sqlite-shm
  users/                             # --data-root，每用户的 DSH_HOME、workspace、日志
    <userId>/                        # join(dataRoot, userId)
      dsh-home/                      # DSH_HOME
      workspace/
      logs/
      tmp/ .cache/ .config/ .local/share/ npm-cache/ pnpm-store/
    profile-template/                # 共享模板 Profile home（在 dataRoot 内）
    public-agents/                   # 公共 Skill（在 dataRoot 内）
    public-mcp.cordis.yml            # 公共 MCP（在 dataRoot 内）
/etc/dsh-multiuser/                  # 配置目录（部署配置）
  gateway.env                        # systemd EnvironmentFile（模型密钥，0600）
  keys/<kid>.pem                     # SSO 公钥，仅服务账号可读
```

注意：`--data-root` 的规范值就是 `/var/lib/dsh-multiuser/users`（即 `join(dataDir, 'users')`），不是 `/var/lib/dsh-multiuser`。`profile-template/`、`public-agents/`、`public-mcp.cordis.yml` 都在 `users/` 这一级里面。备份与恢复命令的 `--data-root` 必须传 `/var/lib/dsh-multiuser/users`；传成上一级会把整个 `users/` 当成一个用户目录，恢复后用户数据落在多一层之下而**全部不可见**（网关按 `<data-root>/<userId>` 定位用户），详见「备份与恢复」失败恢复。

创建服务账号与目录：

```sh
sudo useradd --system --home-dir /var/lib/dsh-multiuser --shell /usr/sbin/nologin dsh-multiuser
sudo install -d -o root -g root -m 0755 /opt/dsh-multiuser
sudo install -d -o dsh-multiuser -g dsh-multiuser -m 0700 /var/lib/dsh-multiuser
sudo install -d -o dsh-multiuser -g dsh-multiuser -m 0700 /var/lib/dsh-multiuser/users
sudo install -d -o root -g root -m 0755 /etc/dsh-multiuser
sudo install -d -o root -g dsh-multiuser -m 0750 /etc/dsh-multiuser/keys
```

成功信号：

```sh
namei -l /var/lib/dsh-multiuser/users
namei -l /etc/dsh-multiuser/keys
```

- `namei -l` 显示 `users` 目录属主为 `dsh-multiuser`，权限为 `drwx------`（0700）。
- `keys` 目录权限为 `drwxr-x---`（0750），group 为 `dsh-multiuser`。

失败恢复：

- 账号已存在：`sudo userdel dsh-multiuser` 后重建；若仅目录权限错，用 `sudo chown -R dsh-multiuser:dsh-multiuser /var/lib/dsh-multiuser && sudo chmod 0700 /var/lib/dsh-multiuser` 修正。
- 权限暴露（group/other 可读写）：立即 `chmod 0700` 收紧，并复查 `doctor` 的 `DATA_PERMISSION` / `DB_PERMISSION` 结果。

## 安装锁定的 DSH

生产部署使用 npm 发布的 DSH，不依赖 Harness 源码 checkout。版本必须取自 `compatibility.json` 的 `testedDshVersions`，不要使用浮动 dist-tag：

```sh
sudo npm install --global @deepseek-ai/dsh@<DSH 精确版本>
dsh --version
```

成功信号：

- `npm install` 退出码为 `0`。
- `dsh --version` 打印的版本等于 `<DSH 精确版本>`，且该版本在 `compatibility.json` 中。

失败恢复：

- 网络或 registry 失败：检查 npm 源与代理，重跑安装，确认退出码 `0`。
- 版本不在兼容矩阵：改用 `compatibility.json` 列出的版本；不要用 `latest`/`alpha` 做生产锁定。
- 安装后 `dsh --version` 为空：确认全局 `bin` 在 `PATH`，或用 `which dsh` 拿到 `<dsh 可执行路径>`。

## 安装 dsh-multiuser（systemd 模式）

`install` 是幂等的：重复执行会原子替换应用目录并保留数据目录。systemd 模式需要 root；非 root 或演练可用 `--system-root <前缀>` 把系统目录重定向到前缀下预览。先做一次 dry-run 查看完整计划与 unit 全文：

```sh
sudo npx dsh-multiuser@<应用版本> install --mode systemd \
  --app-dir /opt/dsh-multiuser \
  --data-dir /var/lib/dsh-multiuser \
  --dsh-command <dsh 可执行路径> \
  --dsh-args '[]' \
  --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --host 127.0.0.1 \
  --port 18088 \
  --allowed-host <网关域名> \
  --service-user dsh-multiuser \
  --dry-run
```

成功信号：

- 退出码为 `0`。
- 输出列出计划步骤：复制应用文件到 `/opt/dsh-multiuser`、创建数据目录、写 unit 到 `/etc/systemd/system/dsh-multiuser.service`、写环境文件到 `/etc/dsh-multiuser/gateway.env`、创建服务账号、准备模板 Profile、运行 `doctor`，并打印完整 `gateway arguments`。

确认无误后正式安装：

```sh
sudo npx dsh-multiuser@<应用版本> install --mode systemd \
  --app-dir /opt/dsh-multiuser \
  --data-dir /var/lib/dsh-multiuser \
  --dsh-command <dsh 可执行路径> \
  --dsh-args '[]' \
  --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --host 127.0.0.1 \
  --port 18088 \
  --allowed-host <网关域名> \
  --service-user dsh-multiuser
```

`install` 在 systemd 模式（`--system-root` 为空）下会把 unit **直接写入** `/etc/systemd/system/dsh-multiuser.service`，并打印启用命令。加载并启用：

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-multiuser
```

演练说明：只有在 `--system-root <前缀>` 暂存场景下，`install` 才会打印一条 `sudo cp <前缀>/etc/systemd/system/dsh-multiuser.service /etc/systemd/system/` 让你把暂存 unit 拷到真实系统目录；真实 root 安装不需要这条 `cp`。

成功信号：

- `install` 退出码为 `0`，输出 `installed to /opt/dsh-multiuser`。
- 若数据库已存在，输出 `database already exists ... accounts and sessions preserved`；首次安装输出 `run init-admin to create the first administrator`。
- `sudo systemctl daemon-reload` 退出码 `0`，无报错。

应用入口为 `/opt/dsh-multiuser/bin/dsh-multiuser`（`install` 创建）。若实际未生成该包装，可用等价入口 `node /opt/dsh-multiuser/dist/src/cli.js` 替代。

失败恢复：

- dry-run 报路径冲突或权限不足：修正 `--app-dir`/`--data-dir` 与目录属主后重跑；`--dry-run` 不写任何文件。
- 正式安装中 `doctor` 失败：`install` 保留上一个可用版本，按 `doctor` 结果码（`NODE_VERSION`、`DSH_COMPATIBILITY`、`PROFILE_COMPOSITION`、`SSO_CONFIG` 等）逐项排查；`--dry-run` 任何时候都能跑。
- 非 root 缺少写 `/opt`、`/etc` 权限：用 `sudo` 或加 `--system-root <前缀>` 演练；不要放宽目录权限绕过。

## 初始化管理员

密码通过 TTY 或标准输入提供，不写入 shell 历史、systemd 参数或环境文件。以服务账号运行，避免数据目录属主错乱。管理员密码至少 12 个字符，否则 `init-admin` 会以 `error: password must contain at least 12 characters` 失败并非 0 退出。

```sh
sudo -u dsh-multiuser /opt/dsh-multiuser/bin/dsh-multiuser init-admin \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --username admin \
  --display-name Administrator
```

非交互场景（如自动化）用标准输入传密码：

```sh
echo -n '<管理员密码>' | sudo -u dsh-multiuser /opt/dsh-multiuser/bin/dsh-multiuser init-admin \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --username admin \
  --display-name Administrator \
  --password-stdin
```

成功信号：

- 交互模式提示 `Password:` 并静默读入。
- 输出 `created administrator admin (<id>)`，其中 `<id>` 为非敏感 UUID。
- 退出码为 `0`。

失败恢复：

- `an administrator already exists`：已有初始管理员，不要重复执行；用 `reset-password` 改密，或 `disable-user` 后重建。
- 数据库目录无写权限：确认 `/var/lib/dsh-multiuser` 属主为 `dsh-multiuser` 且权限 `0700`，再用 `sudo -u dsh-multiuser` 运行。
- 密码读入失败（非 TTY 且未加 `--password-stdin`）：加 `--password-stdin` 从管道读入。
- `password must contain at least 12 characters`：密码不足 12 字符，换用 ≥12 字符的密码重跑 `init-admin`。密码校验失败时 `gateway.sqlite` 可能已被创建为空库，用同一 `--db` 路径重跑即可（不会重复建号）。

## 配置 SSO 公钥

只部署 IdP 公钥，不把签发私钥放在 Gateway 主机。先放置公钥文件：

```sh
sudo install -o root -g dsh-multiuser -m 0640 <SSO 公钥路径> /etc/dsh-multiuser/keys/<SSO kid>.pem
```

成功信号：

```sh
namei -l /etc/dsh-multiuser/keys/<SSO kid>.pem
```

- 文件权限为 `-rw-r-----`（0640），属主 `root`，group `dsh-multiuser`。

Gateway 需要以下四项完整配置（缺一则普通用户无法登录）：

```text
--sso-public-key <SSO kid>=/etc/dsh-multiuser/keys/<SSO kid>.pem
--sso-issuer <IdP issuer>
--sso-audience <IdP audience>
--sso-origin https://<IdP origin>
```

把四项加入 unit 的 `ExecStart`。最稳妥的方式是连同 `--sso-*` 重新执行一次幂等 `install`（会重新生成 unit 并保留数据），再重新加载并重启以应用新参数：

```sh
sudo npx dsh-multiuser@<应用版本> install --mode systemd \
  --app-dir /opt/dsh-multiuser \
  --data-dir /var/lib/dsh-multiuser \
  --dsh-command <dsh 可执行路径> \
  --dsh-args '[]' \
  --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --host 127.0.0.1 --port 18088 --allowed-host <网关域名> \
  --service-user dsh-multiuser \
  --sso-public-key <SSO kid>=/etc/dsh-multiuser/keys/<SSO kid>.pem \
  --sso-issuer <IdP issuer> \
  --sso-audience <IdP audience> \
  --sso-origin https://<IdP origin>
sudo systemctl daemon-reload && sudo systemctl restart dsh-multiuser
```

`restart` 用于重写 unit 后对**正在运行**的服务使新参数生效——`enable --now` 不会重启已在运行的服务，新 `--sso-*` 参数不会生效。若服务此前从未启动过，改用 `sudo systemctl daemon-reload && sudo systemctl enable --now dsh-multiuser`。

也可手工在 `/etc/systemd/system/dsh-multiuser.service` 的 `ExecStart` 末尾追加四行 `--sso-*` 参数（每行以 `\` 续行），再 `sudo systemctl daemon-reload && sudo systemctl restart dsh-multiuser`。

成功信号：

- `install` 重新执行后数据保留，输出 `accounts and sessions preserved`（数据库已存在时）。
- `doctor` 的 `SSO_CONFIG` 为 `ok`，输出 `SSO fully configured`。
- `sudo systemctl cat dsh-multiuser` 能见到四条 `--sso-*` 参数。

失败恢复：

- `SSO_CONFIG` 为 `FAIL` 且提示 `公钥文件缺失`：检查 `/etc/dsh-multiuser/keys/<SSO kid>.pem` 路径与权限。
- `SSO options are incomplete (n/4)`：四项必须同时提供，补齐后重跑。
- 私钥误放主机：立即删除私钥文件，仅保留公钥；轮换 IdP 签发密钥。

公钥轮换时先同时配置旧 `kid` 和新 `kid`（两个 `--sso-public-key`），再切换 IdP 签发密钥。等待旧 token 最大生存时间过期后才移除旧公钥，避免已签发 token 失效。

## 配置 HTTPS 反向代理

以 Nginx 为例。下列模板必须在真实域名和证书上验证后才进入 `deploy/`；当前它不在仓库中，仅在手册内。

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name <网关域名>;

    ssl_certificate     <证书全链路径>;
    ssl_certificate_key <私钥路径>;

    # SSO 登录端点：严格限制请求体，避免大 body 攻击。
    location = /auth/sso {
        client_max_body_size 8k;
        proxy_pass http://127.0.0.1:18088;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    location / {
        proxy_pass http://127.0.0.1:18088;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 3600s;
    }

    # 就绪探针仅允许回环访问，不暴露给公网。
    location = /readyz {
        allow 127.0.0.1;
        deny all;
        proxy_pass http://127.0.0.1:18088;
    }
}
```

Gateway 的 `--allowed-host` 必须包含反向代理传入的精确 `Host`。不使用通配 Host，不信任客户端自行提供的 `X-Forwarded-For`，不记录 Cookie、Authorization、SSO POST body 或 query token。

**已知限制：登录限速的作用域是「直连对端地址 + 用户名」。** `src/gateway.ts` 的 `clientIp()` 取 `req.socket.remoteAddress`，并按上一段刻意不读取 `X-Forwarded-For`。按上面的 nginx 配置，每个客户端到 Gateway 的对端地址都是 `127.0.0.1`，全部落进同一个「客户端」作用域——因此一个未认证客户端可以用约 4100 次不同用户名的登录尝试填满 4096 条限速记录，再用 5 次失败把兜底额度耗尽，在最长 15 分钟内拒绝**所有**新登录，包括携带正确密码的登录。这是可用性 DoS，不涉及凭据泄漏。发布 `0.1.0` 前必须解决，可选方向：为 Gateway 增加仅在直连对端受信任（如回环）时才采信的客户端地址头，或让 Gateway 直接承接 TLS 而不经共享地址的代理。当前版本的缓解手段是在代理层为 `/admin/auth/login` 与登录端点叠加 `limit_req` 并限制其可达面。

代理验收清单（每项都要通过）：

```sh
# 1. 配置语法
sudo nginx -t

# 2. 回环健康检查可达，公网不可达
curl -fsS http://127.0.0.1:18088/healthz
curl -fsS http://127.0.0.1:18088/readyz

# 3. HTTPS 入口与响应头
curl -I https://<网关域名>/healthz

# 4. HTTP -> WebSocket 升级
curl -sN -i \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://<网关域名>/api/remote.mux

# 5. Host 伪造必须被拒（期望非 2xx，通常为 421）
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: evil.example.com" https://<网关域名>/healthz

# 6. 日志不含敏感字段
sudo grep -RniE 'authorization|cookie|token' /var/log/nginx/ | grep -vi '421'
```

成功信号：

- `nginx -t` 输出 `syntax is ok` 与 `test is successful`，退出码 `0`。
- 回环 `/healthz`、`/readyz` 返回 `200`。
- `curl -I https://<网关域名>/healthz` 返回 `HTTP/2 200` 或 `HTTP/1.1 200`。
- WebSocket 升级请求返回 `101 Switching Protocols`（认证前可能先 `401`，但升级握手本身应被代理转发）。
- Host 伪造返回 `421`（或至少非 `200`）；若返回 `200` 说明 `--allowed-host` 未生效。
- 日志 grep 无 `Authorization`/`Cookie`/`token` 命中（第 6 步应为空）。

失败恢复：

- `nginx -t` 失败：按报错修正 `server_name`、证书路径或续行 `\`。
- WebSocket 升级返回非 `101`：确认 `proxy_http_version 1.1` 与 `Upgrade`/`Connection` 透传，且 `proxy_read_timeout` 足够长。
- Host 伪造返回 `200`：在 unit 的 `ExecStart` 确认 `--allowed-host <网关域名>` 已生效，重跑 `systemctl daemon-reload && systemctl restart dsh-multiuser`。
- 日志出现敏感字段：改用不记录 `$http_cookie`/`$http_authorization`/请求体的日志格式，确认后重跑第 6 步。

## systemd 启动验收

生成的单元（由 `install` 写入 `/etc/systemd/system/dsh-multiuser.service`）必须：

- 使用专用 `User` 和 `Group`（`dsh-multiuser`）。
- `WorkingDirectory` 指向不可变应用目录 `/opt/dsh-multiuser`。
- 只从权限受控的 `/etc/dsh-multiuser/gateway.env` 读取非 CLI 密钥。
- `UMask=0077` 并使用 `KillMode=control-group`。
- 将 Gateway 和所有子 Runtime 纳入同一个停止生命周期。
- 不使用 `--insecure-cookies`。

启动并验收：

```sh
sudo systemctl enable --now dsh-multiuser
sudo systemctl status dsh-multiuser
sudo journalctl -u dsh-multiuser --since '-5 minutes' --no-pager
sudo ss -lntp | grep 18088
```

成功信号：

- `systemctl is-active dsh-multiuser` 输出 `active`，退出码 `0`。
- `ss -lntp` 显示 Gateway 只监听 `127.0.0.1:18088`（回环），无公网绑定。
- 日志不包含密钥、token 或 Cookie；无 `error`/`unhandled` 连续报错。

失败恢复：

- 单元失败：`journalctl -u dsh-multiuser -n 100 --no-pager` 查看具体错误；常见为 `--db`/`--data-root` 路径权限或 `--dsh-command` 不可执行。
- 监听了公网地址：确认 unit 中 `--host 127.0.0.1`，重跑 `daemon-reload && restart`。
- 启动后立即退出：`systemctl status` 的 `Main PID` 与 `journalctl` 中的退出码定位；典型为 SSO 参数缺项或 Profile 校验失败。

## 健康与就绪探针

健康检查必须基于三个端点，不能把「登录页返回 200」当作完整链路成功。`status` 命令读取这三个端点并报告管理员初始化状态。

| 路由 | 含义 | 失败条件 | 典型响应 |
| --- | --- | --- | --- |
| `GET /healthz` | Gateway 进程可接受 HTTP | 进程正在关闭或已崩溃 | `200`；失败时连接拒绝或 `503` |
| `GET /readyz` | 可接受新用户流量（DB 可读写、Profile 模板可解析、DSH 版本受支持） | SQLite 不可读写、Profile 模板无法解析、DSH 版本不支持 | `200`；失败时 `503` |
| `GET /version` | 非敏感构建身份（版本、commit、支持的 DSH 版本） | 始终可用，不应失败 | `200` JSON |

`readyz` 不应启动用户 Runtime，也不应向模型提供方发请求。

边界：`readyz` 通过只表示 Gateway 处于可接流状态，**不等于业务链路可用**。SSO 登录、用户会话、模型调用是否在端到端工作，必须用真实 SSO 登录 + 创建会话来验证（见「首次功能验收」）。

探针命令（在主机回环执行，不经公网）：

```sh
curl -fsS http://127.0.0.1:18088/healthz
curl -fsS http://127.0.0.1:18088/readyz
dsh-multiuser --version
curl -fsS http://127.0.0.1:18088/version
```

`status` 命令读取 `/healthz`、`/readyz`、`/version` 三个端点并报告管理员初始化状态：

```sh
sudo -u dsh-multiuser /opt/dsh-multiuser/bin/dsh-multiuser status \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --data-root /var/lib/dsh-multiuser/users \
  --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --dsh-command <dsh 可执行路径> \
  --host 127.0.0.1 --port 18088 \
  --host-header <网关域名>
```

成功信号：

- 退出码 `0`，输出四行：

```text
healthz: ok
readyz: ready
version: {"name":"dsh-multiuser","version":"0.1.0","commit":null,"dsh":{"tested":["0.1.5-rc.1"],"canary":["0.1.6-alpha.1"]},"node":"v24.18.0"}
admin account: initialized
```

- `readyz: ready` 表示 Gateway 可接流；`admin account: initialized` 表示初始管理员已建。

失败恢复：

- `healthz: unreachable (...)` 或 `healthz: draining`：Gateway 未启动或正在关闭，回到「systemd 启动验收」查 `journalctl`。
- `readyz: not ready` 后跟逐条 `  CODE: detail`：按 `doctor` 的 `DB_PERMISSION`/`PROFILE_COMPOSITION`/`DSH_COMPATIBILITY` 等结果码定位；通常是数据目录权限、Profile 源缺失或 DSH 版本不在矩阵。
- `readyz: rejected by Host allow-list (...)`：未在 `status` 里带 `--host-header <网关域名>`，或 unit 的 `--allowed-host` 与探针 Host 不符；补 `--host-header` 或核对 `--allowed-host`。
- `admin account: not initialized`：执行「初始化管理员」。
- `status` 在不可达或状态异常时返回非 `0` 退出码，可直接用于脚本判断。

## 首次功能验收

本步是真实业务链路验收，建议在隔离浏览器上下文中完成（也是第 4 章第五、六关的预演）：

1. 使用 HTTPS 访问 `https://<网关域名>/admin/login`，以本地管理员登录。
2. 在「公共模型」中保存一个测试模型提供方，确认 API 和日志只显示「已配置」状态，不回显密钥。
3. 通过 IdP 以用户 A 登录，创建会话和文件。
4. 通过独立浏览器上下文以用户 B 登录，确认不可见 A 的会话和文件。
5. 管理员添加公共 Skill、插件和 MCP，重启 A/B Runtime，确认两者可见公共资源。
6. A 安装私有资源，重启 A/B Runtime，确认该资源只在 A 中可见。
7. 管理员删除公共资源，重启 Runtime，确认私有资源不受影响。

成功信号：

- 管理员登录后进入 `/admin`，能保存模型提供方且响应不含密钥明文。
- 用户 A、B 各自会话与文件互不可见（用 B 的上下文直接请求 A 的会话 ID 也失败）。
- 公共资源在 A/B 均可见，私有资源仅对 A 可见。

失败恢复：

- SSO 登录失败：回到「配置 SSO 公钥」核对四项与 IdP 值；用 `doctor` 的 `SSO_CONFIG` 复核。
- A/B 互相可见数据：这是阻断级问题，停止部署并上报；说明目录归属或路由隔离失效。
- 资源不同步：确认 Runtime 重启确实发生（管理员控制台查看 Runtime 状态），再查 `profile-template` 合并日志。

## 备份与恢复

`backup` 命令（`src/backup.ts`；停机窗口外也能取一致性快照，待真实主机验证）对运行中的服务做一致性快照，但手册仍建议在停机窗口内备份，以避免 Schema 迁移与快照之间出现边界不一致。签名：

```sh
dsh-multiuser backup \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --data-root /var/lib/dsh-multiuser/users \
  --to <备份目录> \
  --config-dir /etc/dsh-multiuser \
  --json
```

产物形如 `<备份目录>/<时间戳>/{database.sqlite,gateway.env,users/,config/,manifest.json}`。备份目录含密钥材料（SSO 公钥、网关环境文件、共享模型配置），必须按密钥保管。

注意这里有**两个不同的 `gateway.env`**，手册必须同时覆盖：

| 文件 | 谁写 | 作用 | 备份来源 |
|---|---|---|---|
| `/var/lib/dsh-multiuser/gateway.env` | 管理员在「公共模型」里保存 | Gateway 的**共享模型配置**（`DEEPSEEK_API_KEY`、公共 Provider）；`--gateway-env` 默认值就是 `dirname(--db)/gateway.env` | `backup` 自动收进 `<备份目录>/<时间戳>/gateway.env` |
| `/etc/dsh-multiuser/gateway.env` | `install` 创建、运维填写 | systemd `EnvironmentFile` | 由 `--config-dir` 收进 `<备份目录>/<时间戳>/config/gateway.env` |

两者都在数据根与配置目录之外/之内互不重叠，因此缺一不可：**只备份 `--config-dir` 会让恢复后的网关失去管理员在控制台里保存的模型密钥**（已实测：漏掉时 `GET /admin/global-config` 返回 `apiKeyConfigured:false`）。

停机窗口内的推荐流程：

```sh
sudo systemctl stop dsh-multiuser
dsh-multiuser backup \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --data-root /var/lib/dsh-multiuser/users \
  --to <备份目录> \
  --config-dir /etc/dsh-multiuser
sudo systemctl start dsh-multiuser
```

成功信号：

- `systemctl stop` 退出码 `0`，`journalctl` 显示 Gateway 与子 Runtime 均已退出（无孤儿进程）。
- `backup` 退出码 `0`，`<备份目录>/<时间戳>/` 下存在 `database.sqlite`、`gateway.env`、`users/`、`config/` 与 `manifest.json`；`--json` 输出的 `entries` 数组应同时包含 `database.sqlite`、`gateway.env`、`users`、`config`。
- `manifest.json` 含版本与时间戳，且可在停机窗口内生成。

失败恢复：

- `backup` 报错或产物缺失：确认 `--db`、`--data-root`、`--config-dir` 路径存在且可读；停机后重试。
- `--data-root` 必须传 `/var/lib/dsh-multiuser/users`（`users/` 这一级），**不能传成上一级 `/var/lib/dsh-multiuser`**。备份会把该目录的**全部内容**当作数据根；传成上一级会把整个 `users/` 目录当成「一个用户目录」收进备份，恢复后每个用户数据都落在多一层的 `<data-root>/users/<userId>/` 之下。备份本身不丢文件，但恢复后网关按 `<data-root>/<userId>` 找用户（`runtime-manager.ts`），**会为每个用户新建一个空目录，原会话与文件全部不可见**（已实测复现）。
- 服务停止后仍有 Runtime 进程：`sudo pkill -u dsh-multiuser` 清理，确认 `ss -lntp` 无残留端口再备份。

恢复（在独立目录或新主机，使用 `restore` 命令而非裸 `cp`；`restore` 会先校验 `manifest.json` 的 sha256 与 `PRAGMA quick_check`，任何校验失败都在写盘前中止、目标零字节不变；目标非空且无 `--force` 则拒绝，给 `--force` 时把旧数据**移**到 `.pre-restore-<stamp>` 而非删除——数据根、`--db`（位于数据根之外）与共享模型配置各自独立挪一份安全副本）：

```sh
sudo systemctl stop dsh-multiuser
dsh-multiuser restore \
  --from <备份目录>/<时间戳> \
  --data-root /var/lib/dsh-multiuser/users \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --config-dir /etc/dsh-multiuser \
  --force
sudo systemctl start dsh-multiuser
```

成功信号：

- 恢复后 `/readyz` 返回 `200`，管理员登录与 A/B 用户会话均可用，公共资源与用户私有资源完整。
- `restore` 输出的路径清单包含 `restore: model config -> /var/lib/dsh-multiuser/gateway.env`；管理员登录后 `GET /admin/global-config` 返回 `apiKeyConfigured: true`（若为 `false` 说明共享模型配置没进备份，需从备份目录手工补回 `gateway.env`）。
- `manifest.json` 中版本与当前应用版本一致（不一致见「升级与回滚」）。

失败恢复：

- 恢复后 `readyz` 为 `503`：通常是权限错（数据目录非 `0700`，`DB` 检查失败）或 Schema 版本高于当前应用，需回滚到匹配版本。
- **恢复后 `readyz` 仍为 `200`，但用户会话与文件都不见了**：这是数据根层级错了的典型症状，**不要依赖 `readyz` 判断**。网关每次启动都会自动重建 `profile-template`，所以 `PROFILE_TEMPLATE` 这一项检查不会因此报错；真正暴露问题的是每用户目录：网关按 `<data-root>/<userId>` 定位用户（`runtime-manager.ts`），若恢复出的用户数据落在 `<data-root>/users/<userId>/`，网关会为每个用户**新建空目录**，观感就是「用户数据全部丢失」。处理：`ls <data-root>` 应直接看到各用户 UUID 目录与 `profile-template/`；若只看到一个 `users/`，说明 `--data-root` 传成了上一级，把该目录内容上提一级后重启服务。
- 密钥文件权限暴露：恢复后立即 `chmod 0640 /etc/dsh-multiuser/keys/*.pem` 并 `chmod 0600 /etc/dsh-multiuser/gateway.env`。

## 升级与回滚

预览版禁用 `upgrade` 子命令。生产升级唯一支持的路径是：停止服务 → `backup` → 用新版本执行 `install --mode systemd` → 启动服务 → 验证。不要在 Gateway 运行期间复制应用或数据目录。

升级流程：

```sh
sudo systemctl stop dsh-multiuser
dsh-multiuser backup \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --data-root /var/lib/dsh-multiuser/users \
  --to <备份目录> --config-dir /etc/dsh-multiuser
sudo npx dsh-multiuser@<新应用版本> install --mode systemd \
  --app-dir /opt/dsh-multiuser --data-dir /var/lib/dsh-multiuser \
  --dsh-command <dsh 可执行路径> --dsh-args '[]' \
  --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --host 127.0.0.1 --port 18088 --allowed-host <网关域名> \
  --service-user dsh-multiuser \
  --sso-public-key <SSO kid>=/etc/dsh-multiuser/keys/<SSO kid>.pem \
  --sso-issuer <IdP issuer> --sso-audience <IdP audience> \
  --sso-origin https://<IdP origin>
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-multiuser
curl -fsS http://127.0.0.1:18088/readyz
dsh-multiuser --version
```

成功信号：

- 每一步退出码 `0`。
- 升级后 `/readyz` 返回 `200`，`dsh-multiuser --version` 等于本次升级到的 `<新应用版本>`。
- 数据目录未被覆盖（用户会话、账号保留）。

失败恢复（回滚）：

数据库 Schema 升级后**不可降级**：旧版本代码可能打不开新 Schema。回滚必须同时恢复升级前的数据备份，不得只把旧二进制指向新 Schema。

```sh
sudo systemctl stop dsh-multiuser
# 恢复升级前的数据备份（关键：Schema 不可降级）
dsh-multiuser restore \
  --from <备份目录>/<升级前时间戳> \
  --data-root /var/lib/dsh-multiuser/users \
  --db /var/lib/dsh-multiuser/gateway.sqlite \
  --config-dir /etc/dsh-multiuser \
  --force
# 重新安装此前运行的应用版本（必须与升级前数据备份的 Schema 版本一致）
sudo npx dsh-multiuser@<旧应用版本> install --mode systemd \
  --app-dir /opt/dsh-multiuser --data-dir /var/lib/dsh-multiuser \
  --dsh-command <dsh 可执行路径> --dsh-args '[]' \
  --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --host 127.0.0.1 --port 18088 --allowed-host <网关域名> \
  --service-user dsh-multiuser \
  --sso-public-key <SSO kid>=/etc/dsh-multiuser/keys/<SSO kid>.pem \
  --sso-issuer <IdP issuer> --sso-audience <IdP audience> \
  --sso-origin https://<IdP origin>
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-multiuser
curl -fsS http://127.0.0.1:18088/readyz
```

成功信号：

- 回滚后 `/readyz` 返回 `200`，`dsh-multiuser --version` 等于回滚所用的 `<旧应用版本>`（即升级前运行的版本），用户会话与账号完整。

失败恢复：

- 回滚后仍 `503`：确认数据备份与旧应用版本匹配（Schema 版本一致）；若不一致需取更早的备份。
- 安装或验证失败：保持服务停止，先确认升级前备份完整，再按本节回滚流程恢复匹配的数据和应用版本；不要只把旧二进制指向升级后的 Schema。

## 卸载

默认只移除应用并停止服务，保留数据目录。先停服务，再卸载：

```sh
sudo systemctl disable --now dsh-multiuser
sudo rm -f /etc/systemd/system/dsh-multiuser.service
sudo systemctl daemon-reload
dsh-multiuser uninstall \
  --app-dir /opt/dsh-multiuser \
  --data-dir /var/lib/dsh-multiuser
```

要同时删除数据（谨慎）：

```sh
dsh-multiuser uninstall \
  --app-dir /opt/dsh-multiuser \
  --data-dir /var/lib/dsh-multiuser \
  --purge-data
```

成功信号：

- `systemctl is-active dsh-multiuser` 输出 `inactive`，无残留进程。
- 默认卸载输出 `removed /opt/dsh-multiuser; data preserved at /var/lib/dsh-multiuser`。
- `--purge-data` 输出 `removed /opt/dsh-multiuser and /var/lib/dsh-multiuser`，且未触碰根目录/用户 home/工作区根目录。

失败恢复：

- `uninstall` 拒绝危险路径：这是预期保护；确认 `--data-dir` 不是 `/`、用户 home 或当前工作目录，再执行。
- 服务无法停止：`sudo pkill -u dsh-multiuser` 清理后重跑 `disable`。

保留数据重装（验证数据可恢复）：

```sh
sudo npx dsh-multiuser@<新应用版本> install --mode systemd \
  --app-dir /opt/dsh-multiuser --data-dir /var/lib/dsh-multiuser \
  --dsh-command <dsh 可执行路径> --dsh-args '[]' \
  --profile-source /opt/dsh-multiuser/profiles/user-runtime \
  --host 127.0.0.1 --port 18088 --allowed-host <网关域名> \
  --service-user dsh-multiuser
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-multiuser
curl -fsS http://127.0.0.1:18088/readyz
```

成功信号：重装后数据目录未被重建（账号、会话保留），`/readyz` 返回 `200`。

## 完成标准

以下 checkbox 全部保持未勾选，因为需要一名未参与开发的人在全新 Linux 虚拟机上完整执行本手册后才能勾选。每项需要对应的证据写入 `release-evidence/<version>.md`：

- [ ] 本手册已由一名未参与开发的人在全新 Linux 虚拟机上完整执行（证据：执行记录、命令退出码、逐节结果）。
- [ ] 安装、启动、重启、主机重启、升级、备份恢复和卸载均有成功证据（证据：`systemctl` 状态、`/readyz` 结果、备份产物清单）。
- [ ] 反向代理通过 HTTP、WebSocket、SSO body 限制、Host/Origin 和日志脱敏验收（证据：`nginx -t`、升级 `101`、Host 伪造 `421`、日志 grep 为空）。
- [ ] 所有用户 Runtime 只监听回环地址，Gateway 停止后没有孤儿进程（证据：`ss -lntp` 与服务停止后进程检查）。
- [ ] 健康探针使用 `/healthz`、`/readyz`、`/version`，且 `readyz` 不被当作业务链路成功（证据：三端点输出与首次功能验收记录）。
- [ ] 数据库 Schema 升级后回滚同时恢复升级前数据备份，未把旧二进制直接指向新 Schema（证据：回滚演练记录与 `manifest.json` 版本一致）。
- [ ] README 只声明本手册真实验证过的操作系统和拓扑（证据：README 支持版本声明与验证状态表一致）。

**在上述新主机验收之前，本手册并非完全未测**。已在 macOS 上用真实网关、真实 DSH（`compat-work` 内的 `0.1.5-rc.1`）和 npm 打包产物完成以下端到端验证，可作为新主机执行时的对照基线：

1. `install --mode systemd --dry-run` 生成的单元逐行带续行标记核对，`--allowed-host` 确在 `ExecStart` 续行链内（含 SSO 全量场景）；`deploy/dsh-multiuser.service` 样例与生成器输出逐指令一致（有回归测试）。
2. `install --mode local` → `bin/dsh-multiuser --version` → `init-admin` → `doctor` 全链路在安装产物上跑通，`doctor` 在存在 FAIL 时退出码为 1，数据库权限为 `0600`。
3. `/healthz`、`/readyz`（三项 checks 全绿）、`/version` 对真实网关返回 200；伪造 `Host` 返回 421；`status` 识别 `--host-header` 并按健康与否返回 0/1。
4. `backup` → 删除数据根/数据库/共享模型配置 → `restore` → 重启网关：`/readyz` 200，管理员与用户会话可用，用户工作区文件在网关解析的路径下可见，`/admin/global-config` 返回 `apiKeyConfigured:true`。
5. 负向对照：把数据根内容多嵌套一层（即修复前的 `restore` 产物）后启动网关，确认用户数据全部不可见——证明第 4 条不是空跑通过。

仍未覆盖、必须由新主机验收的部分：`systemctl enable --now` / `daemon-reload`、`useradd` 与目录属主、Nginx + TLS + WebSocket、真实 IdP 的 SSO 握手、主机重启后的自启、以及升级/回滚的 Schema 演练。
