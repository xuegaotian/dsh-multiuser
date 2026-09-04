# Contributing to dsh-multiuser

感谢你愿意贡献！本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多用户入口插件集成，欢迎提交 Issue 和 Pull Request。

## 开发环境

需要 Node.js >= 22.19.0 和 pnpm。

```sh
pnpm install
```

## 常用命令

```sh
pnpm test        # 运行 Vitest 测试
pnpm typecheck   # 类型检查（tsc --noEmit）
pnpm build       # 编译到 dist/
```

## 提交前检查

提交前请确保以下命令全部通过：

```sh
pnpm test
pnpm typecheck
pnpm build
```

## 代码规范

- 使用 TypeScript，开启严格模式（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）。
- 修改行为时请补充或更新对应测试。
- 不要提交任何密钥、数据库文件或运行时数据（见 `.gitignore`）。
- 安全相关改动请先阅读 [SECURITY.md](SECURITY.md)。

## 提交信息

使用清晰的提交信息，优先采用约定式提交（Conventional Commits）风格，例如：

```text
feat: add generic SSO sign-in
fix: harden runtime recovery
docs: update deployment guide
```

## 提交流程

1. Fork 本仓库并创建分支。
2. 做出修改并运行上述检查。
3. 提交 Pull Request，描述改动动机和影响。

## 安全

如果你发现了安全漏洞，请勿公开披露，按 [SECURITY.md](SECURITY.md) 的流程私下报告。
