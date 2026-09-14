# Codex 非侵入式记忆接入验证

验证日期：2026-09-14。部署分支：`codex/noninvasive-memory`。

## 环境与结果

- 本机：macOS，Codex CLI 0.149.1，Python 标准库插件；原模型 provider 保持不变。
- 服务：`aws-openclaw` 的 `/root/projects/TencentDB-Agent-Memory`，记忆入口 `http://95.40.122.137:8096/agent-memory/v1`。
- Proxy 扩展已部署；Core 和 Memory Hub 沿用现有服务。写入回执保存在 `tdai-proxy-state` Docker volume。
- GitHub CLI 使用账号 `wwb9523`，凭证保存在本机 keyring，GitHub HTTPS 默认使用 `gh auth git-credential`。仓库不含凭证。

## 已通过的验证

| 范围 | 结果 |
| --- | --- |
| 服务端 Vitest | 10 项通过：鉴权、归属隔离、输入限制、跨会话检索、回执重放、写入结果不确定时拒绝重试、长文本和时间格式 |
| Python unittest | 8 项通过：Hook 召回与原文回写、重复触发、失败重试、作用域隔离、可选采集、MCP 握手、系统代理和 Unicode 边界 |
| 插件结构 | plugin / skill 校验通过；Shell 语法和 git diff 检查通过 |
| 公网合成问答 | 实际运行 UserPromptSubmit / Stop 子进程和 MCP stdio；跨会话查到一条提问、一条回答，重复 Stop 和服务端回执重放没有产生额外记录 |
| L1 | Core 从测试问答自动提炼出“项目 qamemory993e6f84a1a4 使用 pytest”的原子记忆，并可通过公网 atomic search 检索 |
| L2 / L3 | 预置 QA 场景和画像可读；后续 Core 异步处理将上述新项目事实写入场景和画像 |

测试使用独立用户、Team 和 `Codex Memory QA` Agent（`agt-mtjqut5y7h`），仅写入合成内容。L2 / L3 最初有人工种子，因此上述结果证明读取和后续自动更新，不等同于空白 Agent 的全自动冷启动验收。

Proxy 全量 TypeScript 检查存在仓库既有错误；与干净基线比较均为 64 行诊断，新增功能没有引入诊断。不能将本次定向测试通过表述为全仓检查通过。

## 客户端验收边界

本机插件已安装，业务个人绑定尚未设置；QA 凭证使用独立文件，仅供测试。真实使用者仍须按 README 输入自己的 Memory Hub Key，选择本人 Agent，在支持 Hooks 的客户端审阅并信任 Hook，然后新建任务验证触发。没有把子进程测试冒充为桌面端完整会话验收。

自动回写只处理收到 Stop 的完整回合；中断回合不上传。服务端回执面向单实例持久卷，Core 写入与回执之间没有跨服务事务；不确定结果保留 pending 并由管理员核查。公网 HTTP 的访问限制与 HTTPS 建议见接入说明。

## 复现

运行 README 第 5 节中的本地测试和 `remote_smoke.py`。远程联调需要独立 QA 私有配置并显式加 `--allow-qa-write`，请勿用业务 Agent 做写入测试。确认 L0 之后，再等待 Core 异步任务并检索 L1、读取 L2 / L3，不能用固定等待时间代替实际结果检查。

部署脚本输出对应镜像与备份路径。服务器上可用 `git rev-parse HEAD`、`docker inspect tdai-proxy --format '{{.Config.Image}}'` 和 `docker ps` 确认代码、镜像与服务状态。
