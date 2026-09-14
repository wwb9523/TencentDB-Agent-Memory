#!/usr/bin/env bash
# Download and run, or: curl -fsSL http://95.40.122.137:8096/agent-memory/install.sh | bash
set -euo pipefail

# Parse the whole function before executing: stdin may still carry this script.
main() {
  local endpoint="${TDAI_MEMORY_ENDPOINT:-http://95.40.122.137:8096/agent-memory/v1}"
  local install_root="${TDAI_MEMORY_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tdai-memory}"
  local config_file="${TDAI_MEMORY_CONFIG:-$HOME/.config/tdai-memory/config.json}"
  local download_base="${TDAI_MEMORY_DOWNLOAD_BASE:-${endpoint%/v1}}"
  local tmp capture_answer replace_answer
  local configure_args=(configure --endpoint "$endpoint")
  die() { printf '错误：%s\n' "$*" >&2; exit 1; }
  need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖 ${1}，请先安装后重试。"; }
  printf '%s\n' 'TDAI Memory 安装程序' '安装 Hooks + MCP + Skill，保留现有的 Codex provider 和模型 Key。'
  need curl; need tar; need python3; need codex
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || die '需要 Python 3.9 或更高版本。'
  codex plugin add --help >/dev/null || die '当前 Codex 不支持插件，请升级 Codex CLI。'
  # Both shell read and Python input/getpass must use a terminal, never the pipe.
  { exec 3<>/dev/tty; } 2>/dev/null || die '需要交互终端。请下载脚本后在终端执行 bash install-tdai-memory.sh。'

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/tdai-memory.XXXXXX")"
  # Expand while main is active; retain shell quoting for paths containing spaces.
  trap 'rm -rf -- "$tmp"' EXIT
  printf '从记忆服务器下载安装包：%s\n' "${download_base}"
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 120 \
    "${download_base%/}/tdai-memory.tar.gz" -o "$tmp/plugin.tar.gz"
  mkdir -p "$tmp/extract"
  tar -xzf "$tmp/plugin.tar.gz" -C "$tmp/extract"
  local source_root="$tmp/extract"
  [[ -f "$source_root/plugins/tdai-memory/scripts/memory.py" && -f "$source_root/.agents/plugins/marketplace.json" ]] || die '安装包不完整。'
  mkdir -p "$install_root/plugins" "$install_root/.agents/plugins"
  # Only replace the plugin's public files; personal config and outbox live elsewhere.
  cp -R "$source_root/plugins/tdai-memory" "$tmp/ready"
  if [[ -e "$install_root/plugins/tdai-memory" ]]; then
    mv "$install_root/plugins/tdai-memory" "$tmp/previous-plugin"
  fi
  if ! mv "$tmp/ready" "$install_root/plugins/tdai-memory"; then
    if [[ -d "$tmp/previous-plugin" ]]; then mv "$tmp/previous-plugin" "$install_root/plugins/tdai-memory"; fi
    die '无法更新插件目录。'
  fi
  cp "$source_root/.agents/plugins/marketplace.json" "$install_root/.agents/plugins/marketplace.json"
  printf '%s\n' '注册本地 marketplace 并安装插件...'
  codex plugin marketplace add "$install_root" --json || die 'marketplace 注册失败；请检查上方 Codex 错误后重试。'
  codex plugin add tdai-memory@tdai-team --json || die '插件安装失败；请检查上方 Codex 错误后重试。'

  local configure_needed=true
  if [[ -f "$config_file" ]]; then
    printf '已存在个人配置，是否重新输入 Key 并更换绑定？[y/N] ' >&3
    read -r replace_answer <&3
    case "$replace_answer" in
      [Yy]|[Yy][Ee][Ss]) configure_args+=(--replace) ;;
      *) configure_needed=false ;;
    esac
  fi
  if [[ "$configure_needed" == true ]]; then
    printf '%s\n' 'Key 将隐藏输入，保存在个人配置文件中（权限 600）。' >&3
    printf '是否把本轮原始提问和最终回答自动保存到远程记忆？[Y/n] ' >&3
    read -r capture_answer <&3
    case "$capture_answer" in
      ''|[Yy]|[Yy][Ee][Ss]) configure_args+=(--capture) ;;
    esac
    python3 "$install_root/plugins/tdai-memory/scripts/memory.py" "${configure_args[@]}" <&3
  fi
  python3 "$install_root/plugins/tdai-memory/scripts/memory.py" status
  printf '\n%s\n' '安装完成。请重启 Codex，在 /hooks 中审阅并信任两个 Hook，在 /mcp 中确认 tdai-memory 已连接，然后新建任务。'
  printf '插件源码：%s\n个人配置：%s\n' "$install_root/plugins/tdai-memory" "$config_file"
  printf '%s\n' '再次执行脚本可更新插件；默认保留已有 Key 和 Agent 绑定。'
  rm -rf -- "$tmp"
  trap - EXIT
}
main "$@"
