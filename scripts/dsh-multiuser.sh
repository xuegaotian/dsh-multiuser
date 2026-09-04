#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
DSH_ROOT=${DSH_ROOT:-"$SCRIPT_DIR/../deepseek-harness"}
DSH_BIN=${DSH_BIN:-"$DSH_ROOT/apps/cli/lib/bin.js"}
DATA_ROOT=${DATA_ROOT:-"$SCRIPT_DIR/data"}
DB_PATH=${DB_PATH:-"$DATA_ROOT/gateway.sqlite"}
PROFILE_SOURCE=${PROFILE_SOURCE:-"$SCRIPT_DIR/profiles/user-runtime"}
HOST=${HOST:-127.0.0.1}
PORT=${PORT:-18088}
MAX_ACTIVE_RUNTIMES=${MAX_ACTIVE_RUNTIMES:-10}
IDLE_MINUTES=${IDLE_MINUTES:-30}
# SSO is optional. Set these (or export them) to enable SSO sign-in.
SSO_PUBLIC_KEY_FILE=${SSO_PUBLIC_KEY_FILE:-""}
SSO_KEY_ID=${SSO_KEY_ID:-"sso-2026-01"}
SSO_ISSUER=${SSO_ISSUER:-"example-idp"}
SSO_AUDIENCE=${SSO_AUDIENCE:-"dsh-multiuser"}
SSO_ORIGIN=${SSO_ORIGIN:-""}
SSO_SESSION_MINUTES=${SSO_SESSION_MINUTES:-"60"}
INSECURE_COOKIES=1
PID_FILE=${PID_FILE:-"$DATA_ROOT/gateway.pid"}
LOG_FILE=${LOG_FILE:-"$DATA_ROOT/gateway.log"}

command_name=${1:-status}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

read_pid() {
  [[ -s "$PID_FILE" ]] || return 1
  local pid
  pid=$(<"$PID_FILE")
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$pid"
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

owned_process() {
  local command
  command=$(process_command "$1")
  [[ "$command" == *"gateway-cli"* || "$command" == *" dsh-multiuser gateway"* || "$command" == *" gateway "* ]]
}

running_pid() {
  local pid
  pid=$(read_pid) || return 1
  if kill -0 "$pid" 2>/dev/null && owned_process "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

clear_stale_pid() {
  if [[ -e "$PID_FILE" ]] && ! running_pid >/dev/null; then
    rm -f -- "$PID_FILE"
  fi
}

start() {
  mkdir -p -- "$DATA_ROOT"
  clear_stale_pid
  if running_pid >/dev/null; then
    printf 'Gateway 已在运行，PID=%s，地址=http://%s:%s\n' "$(running_pid)" "$HOST" "$PORT"
    return 0
  fi
  [[ -f "$DSH_BIN" ]] || die "找不到最新版 DSH CLI：$DSH_BIN；可设置 DSH_BIN 覆盖"
  [[ -d "$PROFILE_SOURCE" ]] || die "找不到 Runtime Profile：$PROFILE_SOURCE"
  if [[ -n "$SSO_PUBLIC_KEY_FILE" ]]; then
    [[ -f "$SSO_PUBLIC_KEY_FILE" ]] || die "找不到 SSO 公钥：$SSO_PUBLIC_KEY_FILE"
    [[ -n "$SSO_ORIGIN" ]] || die "启用 SSO 时必须设置 SSO_ORIGIN"
  fi

  local -a args=(
    gateway
    --db "$DB_PATH"
    --data-root "$DATA_ROOT/users"
    --dsh-command node
    --dsh-args "[]"
    --launcher-cwd "$DSH_ROOT"
    --launcher-entry "$DSH_BIN"
    --profile user-runtime
    --profile-source "$PROFILE_SOURCE"
    --host "$HOST"
    --port "$PORT"
    --allowed-host "$HOST:$PORT"
  )
  if [[ -n "$SSO_PUBLIC_KEY_FILE" ]]; then
    args+=(
      --sso-public-key "$SSO_KEY_ID=$SSO_PUBLIC_KEY_FILE"
      --sso-issuer "$SSO_ISSUER"
      --sso-audience "$SSO_AUDIENCE"
      --sso-origin "$SSO_ORIGIN"
      --sso-session-minutes "$SSO_SESSION_MINUTES"
    )
  fi
  if [[ "$INSECURE_COOKIES" == 1 ]]; then
    args+=(--insecure-cookies)
  fi
  printf '正在启动 Gateway，日志：%s\n' "$LOG_FILE"
  local log_lines
  log_lines=$(wc -l <"$LOG_FILE" 2>/dev/null | tr -d ' ' || printf '0')
  nohup pnpm --dir "$SCRIPT_DIR" "${args[@]}" </dev/null >>"$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  for _ in {1..50}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 30 "$LOG_FILE" >&2 || true
      rm -f -- "$PID_FILE"
      die 'Gateway 启动失败'
    fi
    if tail -n +$((log_lines + 1)) "$LOG_FILE" 2>/dev/null | grep -q "dsh-multiuser gateway: http://"; then
      printf 'Gateway 已启动，PID=%s，地址=http://%s:%s\n' "$pid" "$HOST" "$PORT"
      return 0
    fi
    sleep 0.2
  done
  printf 'Gateway 进程已启动，PID=%s；尚未看到监听确认，请查看 %s\n' "$pid" "$LOG_FILE"
}

stop() {
  local pid
  pid=$(running_pid || true)
  if [[ -z "$pid" ]]; then
    clear_stale_pid
    printf 'Gateway 未运行\n'
    return 0
  fi
  kill -TERM "$pid"
  local child
  while read -r child; do
    [[ "$child" =~ ^[0-9]+$ ]] && kill -TERM "$child" 2>/dev/null || true
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  for _ in {1..100}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f -- "$PID_FILE"
      printf 'Gateway 已停止\n'
      return 0
    fi
    sleep 0.2
  done
  die "Gateway 未能在 20 秒内停止，PID=$pid；未强制杀死进程，请检查 $LOG_FILE"
}

status() {
  local pid
  if pid=$(running_pid); then
    printf 'Gateway 正在运行，PID=%s，地址=http://%s:%s，日志=%s\n' "$pid" "$HOST" "$PORT" "$LOG_FILE"
  else
    clear_stale_pid
    printf 'Gateway 未运行\n'
  fi
}

case "$command_name" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) die "用法：$0 {start|stop|restart|status}" ;;
esac
