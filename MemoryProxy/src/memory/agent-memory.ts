/** Provider-independent API for local hooks/MCP. Never forwards to an LLM.
 * V1 deliberately supports only the caller's own active agents. Core's data
 * plane trusts identity fields, so this boundary must authenticate every call.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ProxyConfig } from "../types.js";

type Obj = Record<string, any>;
class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 502 | 503, message: string) { super(message); }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function str(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ApiError(400, `invalid_${name}`);
  return value;
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) throw new ApiError(400, "invalid_limit_or_offset");
  return Number(value);
}

export function createAgentMemoryRouter(config: ProxyConfig, options: {
  fetcher?: typeof fetch; receiptDir?: string;
} = {}): Hono {
  const app = new Hono();
  const fetcher = options.fetcher ?? fetch;
  const receiptDir = options.receiptDir ?? process.env.TDAI_AGENT_MEMORY_RECEIPTS ?? "/data/tdai-memory-proxy/agent-memory-receipts";
  app.use("*", bodyLimit({ maxSize: 262144, onError: c => c.json({ error: "body_too_large" }, 413) }));
  app.post("/:operation", async c => {
    try {
      if (!config.tdai.enabled || !config.tdai.endpoint) throw new ApiError(503, "memory_not_configured");
      const key = c.req.header("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!key) throw new ApiError(401, "missing_user_key");
      const service = c.req.header("x-tdai-service-id");
      // This deployment has a single configured instance. Do not let callers
      // redirect the privileged Core credential to an arbitrary tenant.
      if (service !== config.tdai.serviceId) throw new ApiError(403, "invalid_instance");
      let b: Obj;
      try { b = await c.req.json(); } catch { throw new ApiError(400, "invalid_json"); }
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new ApiError(400, "invalid_body");
      const operation = c.req.param("operation");
      if (!["agents", "status", "recall", "search", "scene", "capture"].includes(operation)) throw new ApiError(404, "unknown_operation");
      const headers = {
        "content-type": "application/json", "x-tdai-service-id": service!,
        "x-tdai-user-key": key, authorization: `Bearer ${config.tdai.apiKey || "local"}`,
      };
      const core = async (path: string, payload: Obj): Promise<Obj> => {
        let res: Response;
        try {
          res = await fetcher(`${config.tdai.endpoint.replace(/\/$/, "")}/v3/${path}`, {
            method: "POST", headers, body: JSON.stringify(payload), redirect: "error",
            signal: AbortSignal.timeout(8000),
          });
        } catch { throw new ApiError(502, "core_unavailable"); }
        if (res.status === 401 || res.status === 403) throw new ApiError(res.status, "core_access_denied");
        if (!res.ok) throw new ApiError(502, "core_request_failed");
        let result: Obj;
        try { result = await res.json() as Obj; } catch { throw new ApiError(502, "invalid_core_response"); }
        if (result.code !== 0) throw new ApiError(502, "core_operation_failed");
        return result.data;
      };
      const verified = await core("meta/auth/verify", { user_key: key });
      if (verified?.valid !== true || !verified.user?.user_id) throw new ApiError(401, "invalid_user_key");
      const userId = verified.user.user_id;
      if (operation === "agents") {
        const page = await core("meta/agent/list", {
          owner_user_id: userId, limit: integer(b.limit, 50, 100), offset: integer(b.offset, 0, 100000),
        });
        return c.json({ data: page });
      }
      const teamId = str(b.team_id, "team_id");
      const agentId = str(b.agent_id, "agent_id");
      const [agent, member] = await Promise.all([
        core("meta/agent/get", { agent_id: agentId }),
        core("meta/team-member/get", { team_id: teamId, user_id: userId }),
      ]);
      if (agent?.owner_user_id !== userId || agent.team_id !== teamId || agent.status !== "active" || member?.status !== "active") {
        throw new ApiError(403, "agent_not_owned_or_inactive");
      }
      const identity: Obj = { team_id: teamId, agent_id: agentId, user_id: userId };
      if (b.task_id !== undefined && b.task_id !== "") {
        const taskId = str(b.task_id, "task_id");
        const task = await core("meta/task/get", { task_id: taskId });
        if (task?.team_id !== teamId) throw new ApiError(403, "task_team_mismatch");
        identity.task_id = taskId;
      }
      if (operation === "status") return c.json({ data: { ...identity, agent_name: agent.name, service_id: service, api_version: 1 } });
      if (operation === "recall") {
        const query = str(b.query, "query", 2048);
        const limit = integer(b.limit, 5, 20);
        const [persona, scenarios, atomic] = await Promise.all([
          core("core/read", identity), core("scenario/ls", identity),
          core("atomic/search", { ...identity, query, limit }),
        ]);
        return c.json({ data: { persona, scenarios, atomic } });
      }
      if (operation === "search") {
        if (!["atomic", "conversation"].includes(b.layer)) throw new ApiError(400, "invalid_layer");
        // No session filter: cross-session recall within the authorized agent.
        const result = await core(`${b.layer}/search`, { ...identity, query: str(b.query, "query", 2048), limit: integer(b.limit, 5, 20) });
        return c.json({ data: result });
      }
      if (operation === "scene") return c.json({ data: await core("scenario/read", { ...identity, path: str(b.path, "path", 1000) }) });

      const session = str(b.session_id, "session_id");
      const turn = str(b.turn_id, "turn_id");
      const prompt = str(b.prompt, "prompt", 64000);
      const answer = str(b.answer, "answer", 64000);
      const timestamp = str(b.timestamp, "timestamp", 40);
      if (!Number.isFinite(Date.parse(timestamp))) throw new ApiError(400, "invalid_timestamp");
      const receipt = hash([service, identity, session, turn]);
      const digest = hash([prompt, answer, timestamp]);
      await mkdir(receiptDir, { recursive: true, mode: 0o700 });
      const file = join(receiptDir, `${receipt}.json`);
      // Core currently generates fresh message IDs even when clients supply an
      // id. Persist an exclusive intent BEFORE writing. An uncertain outcome
      // stays pending: never blindly repeat a possibly committed Core write.
      try {
        await writeFile(file, JSON.stringify({ status: "pending", digest, created_at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        const previous = JSON.parse(await readFile(file, "utf8"));
        if (previous.digest !== digest) throw new ApiError(409, "turn_content_conflict");
        if (previous.status !== "done") throw new ApiError(409, "capture_outcome_pending_admin_review");
        return c.json({ data: { captured: true, duplicate: true, receipt } });
      }
      const sessionId = `codex-plugin-${hash([service, identity, session])}`;
      // Core limits each L0 message to 8192 UTF-16 code units. Preserve longer
      // turns as ordered chunks, keeping surrogate pairs intact at boundaries.
      const messages: Obj[] = [];
      for (const [role, content] of [["user", prompt], ["assistant", answer]]) {
        let offset = 0;
        while (offset < content.length) {
          let end = Math.min(offset + 8192, content.length);
          const last = content.charCodeAt(end - 1);
          if (end < content.length && last >= 0xD800 && last <= 0xDBFF) end--;
          messages.push({ role, content: content.slice(offset, end), timestamp: new Date(timestamp).toISOString() });
          offset = end;
        }
      }
      await core("conversation/add", {
        ...identity, session_id: sessionId,
        messages,
      });
      await writeFile(`${file}.done`, JSON.stringify({ status: "done", digest, session_id: sessionId, completed_at: new Date().toISOString() }), { mode: 0o600 });
      await rename(`${file}.done`, file);
      return c.json({ data: { captured: true, duplicate: false, receipt } });
    } catch (e) {
      if (e instanceof ApiError) return c.json({ error: e.message }, e.status);
      // Avoid leaking credentials, stored content or upstream response bodies.
      return c.json({ error: "memory_service_error" }, 503);
    }
  });
  app.all("*", c => c.json({ error: "unknown_operation" }, 404));
  return app;
}
