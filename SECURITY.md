# Security Policy

## Supported Versions

当前仅支持 `main` 分支上的最新版本。我们不会为历史版本提供安全补丁。

## Reporting a Vulnerability

**请勿公开披露安全漏洞。** 请通过 GitHub 的
[Private Vulnerability Reporting](https://github.com/<owner>/dsh-multiuser/security/advisories/new)
功能私下报告，或联系仓库维护者。

请在报告中包含：

- 受影响的版本或提交
- 复现步骤
- 潜在影响
- 如可能，附上修复建议或补丁

我们会在确认后尽快响应，并在修复发布前与你协调披露时间。

## 安全注意事项

本项目是 DeepSeek Harness 的多用户入口插件集成。请特别注意：

- 本项目提供每用户目录、会话和 Runtime 进程路由，但**不是**对抗恶意租户的操作系统级沙箱；当前版本面向可信内部用户。
- 不要将 SSO 签发私钥部署到 Gateway 主机；公钥文件应限制为服务账号只读。
- 不要在生产环境使用 `--insecure-cookies`。
- 不要将包含 `KEY` / `PASSWORD` / `SECRET` / `TOKEN` 的环境变量暴露给用户 Runtime。
- 反向代理不得记录 Cookie 或 POST body，`/auth/sso` 请求体上限应为 8 KiB。
