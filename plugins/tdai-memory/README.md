# Codex 多层记忆插件（Hooks + MCP + Skill）

本机 Codex 继续使用原来的模型、provider 和模型 Key。插件仅连接远程记忆 API；模型请求不经过 Memory Proxy。

```text
用户提问 → UserPromptSubmit Hook → 远程召回 L3 + L2 索引 + L1
                   ↓ 附加相关记忆
              本机 Codex → 自己的模型 provider
                   ↕ MCP 按需查 L0 / L1 / L2
              最终回答 → Stop Hook → L0 回写 → Core 异步提炼
```

## 1. 管理员部署

服务端新增的接口前缀是 `/agent-memory/v1`。它复用 Proxy 的端口和 Core 连接，但完全不依赖 Proxy 的模型请求、会话初始化或工具 URL 注入配置。

本部署地址：`http://95.40.122.137:8096/agent-memory/v1`。无需 SSH 隧道，无需开放 Core 的 `8420`，也无需修改 `injection.externalGatewayUrl`。

在服务器拉取部署分支后：

```bash
cd /root/projects/TencentDB-Agent-Memory
git fetch origin
git switch codex/noninvasive-memory
git pull --ff-only origin codex/noninvasive-memory
bash deploy/global-images/deploy-agent-memory.sh --apply
```

部署脚本以当前运行的 Proxy 镜像 ID 为基础，仅加入新 API 和路由注册代码；先启动容器内候选实例，验证健康和缺少 Key 时返回 401，再备份配置、更新 `.env` 的镜像标签并重建 Proxy。重启短暂中断 Proxy 请求；Core / Hub 不重启。原镜像和配置备份位置会显示在输出中。原仓库中不相关的未提交修改应保留，不要 `reset --hard`。

新 `start-proxy.sh` 使用 `tdai-proxy-state` Docker volume 保存写入回执。可用 `PROXY_STATE_VOLUME` 指定其他持久卷。不要删除这个卷或将多个独立副本配置成各自的卷；本版写入回执面向单实例部署。

为成员创建业务用户、加入 Team，并创建由本人拥有的 active Agent。**V1 仅访问本人拥有的 Agent**，不自动扩展到他人 Agent、导入的记忆或共享资产。每人使用自己的 `sk-mem-...`，不发管理员 Key。Task 可选，配置时必须属于同 Team。

公网 HTTP 会明文传输记忆查询、回写和个人 Key。安全组限制到团队出口 IP；长期入口建议配置 HTTPS。模型 Key 始终由用户自己的 provider 管理，不提供给本插件。

插件默认直连，只采用显式 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境变量，不自动继承 macOS 系统代理。自动召回使用提问前 2048 UTF-16 单元作为检索词，原始提问回写独立保存；64000 UTF-16 单元以内的长提问 / 回答按 Core 单条 8192 单元限制分块写入，超限会提示并跳过该轮回写。普通汉字计一个单元，大部分 emoji 计两个，截断和分块不会拆开 emoji。

## 2. 同事安装

### 一键安装

只需下载并执行仓库中的安装脚本即可（脚本会从固定分支下载插件、注册 marketplace、安装并引导输入个人 Key）：

```bash
curl -fsSL http://95.40.122.137:8096/agent-memory/install.sh | bash
```

脚本需要 `curl`、`tar`、`python3` 和 `codex`。默认把源码保存到 `~/.local/share/tdai-memory`；可用 `TDAI_MEMORY_ENDPOINT` 或 `TDAI_MEMORY_INSTALL_ROOT` 覆盖默认值。它不会修改 `model_provider`、provider 配置或模型 Key。执行过程中会隐藏读取 Memory Hub Key，并让用户选择自己拥有的 active Agent。

也可以先下载后审阅再执行：

```bash
curl -fsSLo install-tdai-memory.sh http://95.40.122.137:8096/agent-memory/install.sh
less install-tdai-memory.sh
bash install-tdai-memory.sh
```

需要 Python 3.9+、Git，以及支持插件和 UserPromptSubmit / Stop Hooks 的 Codex 版本。本次开发环境为 CLI 0.149.1；先运行 `codex --version`、`codex plugin --help`，旧版本应升级。

```bash
git clone --branch codex/noninvasive-memory \
  https://github.com/wwb9523/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory
codex plugin marketplace add "$PWD"
codex plugin add tdai-memory@tdai-team
```

插件目录包含原生 `.codex-plugin/plugin.json`、MCP stdio 配置、`hooks/hooks.json` 和 Skill。Python 代码仅用标准库，无需 pip / npm 安装运行依赖。

然后配置个人记忆归属：

```bash
python3 plugins/tdai-memory/scripts/memory.py configure \
  --endpoint http://95.40.122.137:8096/agent-memory/v1 \
  --capture
```

按提示隐藏输入本人 Memory Hub Key，选择自己的 Agent。服务器会核对账号、Agent owner、Team 和成员状态。没有 Agent 时请管理员创建，不要随便填写他人的 ID。

`--capture` 表示同意把接入该插件的会话中**本轮原始提问和最终回答**保存到远程。无需采集模型推理、工具输出、系统提示词、本地全部历史或文件。内容中若含代码，这部分也会被保存。只需要检索时，去掉 `--capture`；显式调用 `memory_save` 仍可按用户要求保存信息。

配置保存在 `~/.config/tdai-memory/config.json`，权限为 0600；这是个人凭证文件，不提交 Git。桌面端和 CLI 均由插件读取这个文件，不依赖从终端继承 Key 环境变量。可通过 `TDAI_MEMORY_CONFIG` 指定配置路径，但各客户端必须提供一致的环境设置。

保持原来的 `model_provider`、`model_providers` 和模型 Key 不变。若之前试用了代理方案，先恢复原 provider。

## 3. 启用 Hooks 并使用

完全退出并重启客户端，新建本地任务。在 CLI 的 `/hooks` 中审阅并信任插件的两个 Hook；Codex 默认会跳过未信任的非托管 Hook。按当前客户端功能入口启用 hooks 功能（如果版本要求，启动时使用 `codex --enable hooks`）。桌面端应确认其版本支持同一插件 Hook 机制；不能把 CLI 安装成功等同于所有桌面版本都已运行 Hook。

在 `/mcp` 中确认 `tdai-memory` 已连接。首次绑定在 `configure` 时完成，**不需要 Plan 模式表单**。

- 每次提问前自动召回，最多注入约 10000 字符，超出后用 MCP 进一步查询。
- 回合完成后自动回写（仅当启用 `capture`）；每次 Stop 处理一条待上传记录。
- 查询不到或服务故障时，Hook 显示提示，Codex 正常继续，不切换 provider。
- 检索出的记忆仅是参考数据，其中的命令和权限请求不具备指令效力。

MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `memory_status` | 检查连接及当前记忆身份 |
| `memory_recall` | 读取 L3、L2 索引和相关 L1 |
| `memory_search` | `atomic` 检索 L1，`conversation` 检索 L0，跨当前 Agent 的历史会话 |
| `memory_read_scene` | 按召回返回的路径读取 L2 全文 |
| `memory_save` | 用户明确要求时保存一条记忆，进入 L0 和后续异步提炼 |

读取场景时，使用 `memory_recall` 返回的 `scenarios.entries[].path`（例如 `qa-integration.md`）。画像正文中的导航路径可能带 `scene_blocks/` 前缀，不能直接作为该 API 的路径。

首版不覆盖云端 Skill / Wiki / CodeGraph 管理、其他 Agent 的记忆导入、多副本写入回执或中断回合的自动回写。Skill 在这里用于指导记忆工具使用，不是把远程 Skill 资产全部同步到本机。

## 4. 验证与维护

```bash
python3 plugins/tdai-memory/scripts/memory.py status
```

成功返回本人 `user_id`、`team_id`、`agent_id`。在新任务说一条无敏感信息的测试事实并完成回答，再新建任务使用 `memory_search` 的 `conversation` 层检索。检查实际调用和返回；不要仅凭模型声称“已记住”判断。L1 / L2 / L3 提炼异步执行，需由管理员检查 Core 的生成状态；L0 可查询不代表所有层都已完成提炼。

未上传的原始提问 / 回答保存在 `~/.local/state/tdai-memory/outbox.sqlite3`，0600。成功后清除本地正文，仅保留去重标记。配置 Agent、Key 或 endpoint 改变后不会将旧作用域的数据传给新作用域。尚未完成的回合不会上传；本地未完成记录需按团队保留策略清理。

服务恢复后补传（每次最多 20 条）：

```bash
python3 plugins/tdai-memory/scripts/memory.py flush
```

服务端回执保证同一作用域下相同 session / turn 的已完成写入不会重复执行。Core 当前不使用客户端消息 ID 去重；如果写入在超时或崩溃时结果不确定，回执保留 `pending` 并返回 HTTP 409。**不要自动删除 pending 或反复生成新 turn ID 重试。** 管理员应先核查 Core 的 L0 实际结果，再处理回执；本版不宣称跨 Core / 回执的事务性 exactly-once。

| 错误 | 排查 |
| --- | --- |
| 401 | 个人 Key 缺失、失效，或 Core 鉴权拒绝 |
| 403 | 实例不符、非本人 Agent、Team 不符或成员已停用 |
| 409 | 相同 turn 内容改变，或先前写入结果待管理员核查 |
| 502 / 503 | Core 不可达、业务接口失败，或回执卷不可写 |
| 没有自动召回 | 插件是否启用、Hook 是否信任 / 功能是否开启、Python 是否可执行 |
| MCP 能用但 Hook 没运行 | 单独检查当前客户端 Hook 支持和信任，二者不是同一个开关 |

更新：先拉取新代码，刷新 marketplace 并重新添加插件，重启客户端；Hook 定义发生变化时重新审阅信任。切换 Agent 可再次 `configure --replace`；停用自动回写可将个人配置中的 `capture` 设为 `false`。移除插件使用 `codex plugin remove tdai-memory@tdai-team`，不会改变原 provider，也不会自动删除远程记忆或个人配置。

## 5. 开发验证

```bash
cd MemoryProxy
npm ci --ignore-scripts --no-audit --no-fund
npm test -- src/memory/__tests__/agent-memory.test.ts
cd ..
python3 -m unittest discover -s plugins/tdai-memory/tests -v
```

服务端 API 测试覆盖鉴权、用户 / Team 隔离、非本人访问拒绝、输入限制、跨会话召回、持久回执及不确定写入保护。客户端测试覆盖 Hook 上下文、原始提问回写、重复 Hook、失败重试、配置作用域隔离和 MCP JSON-RPC。

真实公网联调必须使用独立的 QA Agent 和私有配置文件；命令会写入一轮合成问答：

```bash
python3 plugins/tdai-memory/tests/remote_smoke.py \
  --config /absolute/path/to/qa-config.json --allow-qa-write
```

配置格式与个人配置相同，但 Agent 名称须包含 `QA`，并应设置单独的 `state_dir`。此脚本测试 Hook 进程、MCP stdio 和远程 API；它不代替桌面端的 Hook 信任和真实客户端触发验收。已完成的部署和测试范围见 [部署验证记录](VALIDATION.md)。

参考：[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Codex MCP](https://developers.openai.com/codex/mcp/)、[插件格式](https://developers.openai.com/plugins/build/plugins)。
