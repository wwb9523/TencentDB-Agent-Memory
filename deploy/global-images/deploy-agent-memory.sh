#!/usr/bin/env bash
# Run from a clean/reviewed checkout after pulling the intended commit.
# Preserves existing environment and installs only the Proxy extension.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
if [[ "${1:-}" != "--apply" ]]; then
  echo 'Usage: bash deploy-agent-memory.sh --apply'
  echo 'Builds from the current Proxy image, verifies a local candidate, backs up deployment configuration, then replaces Proxy.'
  exit 1
fi
revision="$(git -C "$repo_dir" rev-parse --short=12 HEAD)"
base_image="$(docker inspect tdai-proxy --format '{{.Image}}')"
new_image="tdai-memory-proxy:agent-memory-$revision"
backup_dir="$script_dir/.agent-memory-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -p "$script_dir/.env" "$backup_dir/env"
cp -p "$script_dir/.proxy-config/config.yaml" "$backup_dir/config.yaml"
docker inspect tdai-proxy --format '{{.Config.Image}}' > "$backup_dir/image"
chmod 600 "$backup_dir/"*
docker build --build-arg "BASE_IMAGE=$base_image" -f "$repo_dir/MemoryProxy/Dockerfile.agent-memory" -t "$new_image" "$repo_dir"
candidate="tdai-proxy-memory-check-$revision"
cleanup() { docker rm -f "$candidate" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$candidate" --network tdai-memory-stack \
  -v "$script_dir/.proxy-config/config.yaml:/data/config.yaml:ro" \
  "$new_image" >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$candidate" curl -fsS http://127.0.0.1:8096/health >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$candidate" curl -fsS http://127.0.0.1:8096/health >/dev/null
status="$(docker exec "$candidate" curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8096/agent-memory/v1/status)"
[[ "$status" == "401" ]] || { echo "Candidate auth check failed: $status"; exit 1; }
cleanup
# The .env loader overrides shell values, so persist the exact local image tag.
python3 - "$script_dir/.env" "$new_image" <<'PY'
from pathlib import Path
import re, sys
p = Path(sys.argv[1])
s = p.read_text()
s, count = re.subn(r'^PROXY_IMAGE=.*$', 'PROXY_IMAGE=' + sys.argv[2], s, flags=re.M)
if count != 1:
    raise SystemExit('Expected exactly one PROXY_IMAGE entry')
p.write_text(s)
PY
if ! bash "$script_dir/start-proxy.sh"; then
  cp -p "$backup_dir/env" "$script_dir/.env"
  bash "$script_dir/start-proxy.sh"
  echo "Deployment failed; restored previous image. Backup: $backup_dir" >&2
  exit 1
fi
echo "Deployed $new_image. Rollback: restore $backup_dir/env to $script_dir/.env, then run start-proxy.sh."
