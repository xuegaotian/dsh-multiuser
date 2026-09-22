#!/usr/bin/env bash
#
# Replace every repository-identity placeholder in one pass.
#
#   scripts/set-repository-identity.sh --github-owner <user> [--npm-scope <scope>] [--dry-run]
#
# Decisions behind the two values are documented in
# docs/open-source-release/05-repository-identity.md.
#
# Default (no --npm-scope) publishes the unscoped package name `dsh-multiuser`,
# matching `package.json` as it stands. Passing --npm-scope switches the package
# to `@<scope>/dsh-multiuser`, which requires editing `package.json`'s `name`
# and the hardcoded install path in the tarball integration test.
#
# This script rewrites real references only (package name usages and GitHub
# URLs). Lines that mention the placeholder as a concept — "not done yet" notes
# and gate check commands — are left alone and must be updated by hand; step 3
# of docs/open-source-release/05-repository-identity.md lists them.

set -Eeuo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

GITHUB_OWNER=""
NPM_SCOPE=""
DRY_RUN=0

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
用法：scripts/set-repository-identity.sh --github-owner <user> [选项]

必填：
  --github-owner <user>   GitHub 用户名（GitHub URL 中斜杠之前那段，不是昵称）

可选：
  --npm-scope <scope>     使用 scoped 包名 @<scope>/dsh-multiuser。
                          省略则使用无 scope 包名 dsh-multiuser。
  --dry-run               只显示将要发生的改动，不写入任何文件。
  -h, --help              显示本帮助。

示例：
  scripts/set-repository-identity.sh --github-owner xuegaotian --dry-run
  scripts/set-repository-identity.sh --github-owner xuegaotian
  scripts/set-repository-identity.sh --github-owner xuegaotian --npm-scope mynpmname
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --github-owner) GITHUB_OWNER=${2:-}; shift 2 ;;
    --npm-scope) NPM_SCOPE=${2:-}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[[ -n "$GITHUB_OWNER" ]] || die "缺少 --github-owner（用 --help 查看用法）"

# GitHub usernames: alphanumerics and single hyphens, no leading/trailing hyphen.
if [[ ! "$GITHUB_OWNER" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]]; then
  die "GitHub 用户名格式不合法：$GITHUB_OWNER（只能用字母、数字和连字符，且不能以连字符开头或结尾）"
fi

if [[ -n "$NPM_SCOPE" ]]; then
  # npm scope names are lowercase and URL-safe.
  if [[ ! "$NPM_SCOPE" =~ ^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$ ]]; then
    die "npm scope 格式不合法：$NPM_SCOPE（必须小写，只能用字母、数字、点、下划线和连字符）"
  fi
  PACKAGE_PREFIX="@${NPM_SCOPE}/"
  PACKAGE_NAME="@${NPM_SCOPE}/dsh-multiuser"
else
  PACKAGE_PREFIX=""
  PACKAGE_NAME="dsh-multiuser"
fi

TARGETS=(
  package.json
  SECURITY.md
  README.md
  docs/open-source-release/README.md
  docs/open-source-release/02-installation-packaging.md
  docs/open-source-release/03-production-deployment.md
  docs/open-source-release/04-release-validation.md
)
if [[ -n "$NPM_SCOPE" ]]; then
  TARGETS+=(test/install-pack.integration.test.ts)
fi

# Only real references are rewritten: the scoped package prefix and the GitHub
# URL. A bare placeholder is deliberately NOT replaced wholesale, because the
# same token also appears inside check commands and "still to do" notes, where
# substituting the real value would silently falsify the text — e.g. a gate
# command that searches for the placeholder would start searching for the real
# username and then always report a false positive. Those lines are rewritten by
# hand in step 3 of docs/open-source-release/05-repository-identity.md.
filter_for() {
  local target=$1
  local -a exprs=(
    "s|@<owner>/|${PACKAGE_PREFIX}|g"
    "s|github\\.com/<owner>|github.com/${GITHUB_OWNER}|g"
  )
  if [[ -n "$NPM_SCOPE" ]]; then
    case "$target" in
      package.json)
        exprs+=("s|\"name\": \"dsh-multiuser\"|\"name\": \"${PACKAGE_NAME}\"|")
        ;;
      test/install-pack.integration.test.ts)
        exprs+=("s|node_modules/dsh-multiuser|node_modules/${PACKAGE_NAME}|g")
        ;;
    esac
  fi
  local -a args=()
  local expr
  for expr in "${exprs[@]}"; do args+=(-e "$expr"); done
  sed "${args[@]}"
}

printf '仓库：%s\n' "$REPO_ROOT"
printf 'GitHub owner：%s\n' "$GITHUB_OWNER"
printf 'npm 包名：%s\n' "$PACKAGE_NAME"
printf '模式：%s\n\n' "$([[ $DRY_RUN -eq 1 ]] && printf 'dry-run（不写入）' || printf '写入')"

BACKUP_DIR=""
if [[ $DRY_RUN -eq 0 ]]; then
  BACKUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dsh-multiuser-identity-backup-XXXXXX")
  printf '备份目录：%s\n' "$BACKUP_DIR"
  printf '回退方式：cp -R "%s/." "%s/"\n\n' "$BACKUP_DIR" "$REPO_ROOT"
fi

changed_count=0
skipped_count=0

for target in "${TARGETS[@]}"; do
  source_file="$REPO_ROOT/$target"
  if [[ ! -f "$source_file" ]]; then
    printf '跳过（不存在）：%s\n' "$target"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  preview_file=$(mktemp "${TMPDIR:-/tmp}/dsh-multiuser-identity-preview-XXXXXX")
  filter_for "$target" <"$source_file" >"$preview_file"

  if cmp -s "$source_file" "$preview_file"; then
    printf '无改动：%s\n' "$target"
    rm -f -- "$preview_file"
    continue
  fi

  printf '改动：%s\n' "$target"
  if [[ $DRY_RUN -eq 1 ]]; then
    diff -u "$source_file" "$preview_file" | tail -n +3 || true
    printf '\n'
  else
    mkdir -p -- "$BACKUP_DIR/$(dirname -- "$target")"
    cp -p -- "$source_file" "$BACKUP_DIR/$target"
    # Write through the original inode so file permissions are preserved.
    cat -- "$preview_file" >"$source_file"
  fi
  rm -f -- "$preview_file"
  changed_count=$((changed_count + 1))
done

printf '\n改动文件数：%s\n' "$changed_count"

if [[ $DRY_RUN -eq 1 ]]; then
  printf '未写入任何文件。去掉 --dry-run 即可执行。\n'
  exit 0
fi

# Confirm the placeholder is gone from the whole tree, tracked or not.
# A few files keep the literal placeholder by design: they hold the gate check
# commands that search for it, plus this script, which documents the replacement.
# Excluding them is what keeps the scan a real gate instead of a self-referential
# check that always reports the placeholder it is supposed to prove is gone.
printf '\n扫描残留占位符...\n'
EXEMPT_RELATIVE=(
  "docs/open-source-release/04-release-validation.md"
  "docs/open-source-release/05-repository-identity.md"
  "scripts/set-repository-identity.sh"
)

remaining=$(find "$REPO_ROOT" \
  \( -name .git -o -name node_modules -o -name compat-work -o -name compat-work-alpha -o -name dist -o -name .workbuddy \) -prune -o \
  -type f -print0 |
  xargs -0 grep -l "<owner>" 2>/dev/null || true)

pending=""
while IFS= read -r hit; do
  [[ -n "$hit" ]] || continue
  relative=${hit#"$REPO_ROOT"/}
  skip=0
  for exempt in "${EXEMPT_RELATIVE[@]}"; do
    if [[ "$relative" == "$exempt" ]]; then
      skip=1
      break
    fi
  done
  if [[ $skip -eq 1 ]]; then
    continue
  fi
  pending+="$relative"$'\n'
done <<<"$remaining"

if [[ -n "$pending" ]]; then
  printf '以下文件仍含占位符字样，需按第 5 章步骤 3 改写语义后清零：\n%s' "$pending" >&2
  exit 1
fi
printf '占位符已清零（%d 个文件按设计保留检查命令中的占位符，已豁免）。\n\n' "${#EXEMPT_RELATIVE[@]}"

printf '下一步：\n'
printf '  1. 复核改动：git diff\n'
printf '  2. 复核命令：node -p "require(\x27./package.json\x27).repository.url"\n'
printf '  3. 跑一遍测试：NODE_OPTIONS= pnpm typecheck && NODE_OPTIONS= pnpm test\n'
printf '  4. 按文档第 5 章步骤 3 更新三处描述性文字，再建 GitHub 仓库并 push\n'
