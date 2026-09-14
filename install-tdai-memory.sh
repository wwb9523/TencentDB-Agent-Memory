#!/usr/bin/env bash
# One-command installer for the provider-independent TDAI Codex memory plugin.
# Usage: curl -fsSL http://95.40.122.137:8096/agent-memory/install.sh | bash
set -euo pipefail

REPO_URL="https://github.com/wwb9523/TencentDB-Agent-Memory"
BRANCH="codex/noninvasive-memory"
ENDPOINT="${TDAI_MEMORY_ENDPOINT:-http://95.40.122.137:8096/agent-memory/v1}"
INSTALL_ROOT="${TDAI_MEMORY_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tdai-memory}"
PLUGIN_PATH="$INSTALL_ROOT/plugins/tdai-memory"
ARCHIVE_URL="$REPO_URL/archive/refs/heads/${BRANCH//\//%2F}.tar.gz"

die() { echo "错误：$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖 $1，请先安装后重试。"; }
echo "TDAI Memory 安装程序"
echo "将保留你现有的 Codex provider 和模型 Key，仅安装 Hooks + MCP + Skill。"
need curl; need tar; need python3; need codex

tmp="$(mktemp -d "${TMPDIR:-/tmp}/tdai-memory.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
echo "下载插件（分支 ${BRANCH}）..."
curl --fail --location --silent --show-error "$ARCHIVE_URL" -o "$tmp/repo.tar.gz"
mkdir -p "$tmp/extract"
tar -xzf "$tmp/repo.tar.gz" -C "$tmp/extract"
source_root="$(find "$tmp/extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$source_root" && -f "$source_root/plugins/tdai-memory/scripts/memory.py" ]] || die "下载内容不完整。"
mkdir -p "$INSTALL_ROOT"
staging="$INSTALL_ROOT/.staging.$$"
rm -rf "$staging"
mkdir -p "$staging"
cp -R "$source_root/plugins" "$staging/"
cp -R "$source_root/.agents" "$staging/"
rm -rf "$PLUGIN_PATH"
mkdir -p "$(dirname "$PLUGIN_PATH")"
mv "$staging/plugins/tdai-memory" "$PLUGIN_PATH"
rm -rf "$staging"

marketplace="$INSTALL_ROOT/.agents/plugins/marketplace.json"
mkdir -p "$(dirname "$marketplace")"
cp "$source_root/.agents/plugins/marketplace.json" "$marketplace"
echo "注册本地 marketplace..."
codex plugin marketplace add "$INSTALL_ROOT" >/dev/null 2>&1 || true
echo "安装或更新 tdai-memory 插件..."
codex plugin add tdai-memory@tdai-team --json

echo
echo "现在配置个人 Memory Hub Key（输入时不会显示）。"
echo "Key 只保存到 ~/.config/tdai-memory/config.json，权限为 600，不会写入 Git。"
read -r -p "是否启用完成回合自动回写？[Y/n] " capture_answer
case "${capture_answer:-Y}" in
  [Yy]|[Yy][Ee][Ss]) capture_flag=(--capture) ;;
  *) capture_flag=() ;;
esac
python3 "$PLUGIN_PATH/scripts/memory.py" configure --endpoint "$ENDPOINT" "${capture_flag[@]}"
python3 "$PLUGIN_PATH/scripts/memory.py" status

cat <<EOF

安装完成。请：
1. 完全退出并重启 Codex；
2. 在 /hooks 中审阅并信任 TDAI Memory 的 UserPromptSubmit 和 Stop Hook；
3. 在 /mcp 中确认 tdai-memory 已连接；
4. 新建任务测试记忆召回。

插件源码：$PLUGIN_PATH
配置文件：$HOME/.config/tdai-memory/config.json
更新方式：再次执行本脚本（可用 TDAI_MEMORY_ENDPOINT / TDAI_MEMORY_INSTALL_ROOT 覆盖默认值）。
EOF
