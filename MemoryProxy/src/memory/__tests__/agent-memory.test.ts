import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentMemoryRouter } from "../agent-memory.js";
import type { ProxyConfig } from "../../types.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const config = { tdai: { enabled: true, endpoint: "http://core", serviceId: "default", apiKey: "internal-secret" } } as ProxyConfig;
async function setup(overrides: Record<string, any> = {}) {
  const receiptDir = await mkdtemp(join(tmpdir(), "agent-memory-test-")); dirs.push(receiptDir);
  const payloads: Record<string, any>[] = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    const path = String(url).replace("http://core/v3/", "");
    payloads.push({ path, body: JSON.parse(init.body), headers: init.headers });
    let data: any = {
      "meta/auth/verify": { valid: true, user: { user_id: "u1" } },
      "meta/agent/get": { owner_user_id: "u1", team_id: "t1", status: "active", name: "Mine" },
      "meta/team-member/get": { status: "active" },
      "meta/task/get": { team_id: "t1" },
      "core/read": { content: "persona" }, "scenario/ls": { entries: [] },
      "atomic/search": { items: [{ content: "fact" }] },
      "conversation/add": { total_count: 2 },
    }[path] ?? {};
    if (path in overrides) data = overrides[path];
    if (data instanceof Error) throw data;
    return Response.json({ code: 0, data });
  }) as typeof fetch;
  const app = createAgentMemoryRouter(config, { fetcher, receiptDir });
  const post = (op: string, b: any = {}, auth = "Bearer personal") => app.request(`/${op}`, {
    method: "POST", headers: { authorization: auth, "x-tdai-service-id": "default", "content-type": "application/json" },
    body: JSON.stringify({ team_id: "t1", agent_id: "a1", ...b }),
  });
  return { app, post, payloads, receiptDir, fetcher };
}
const turn = { session_id: "session", turn_id: "turn", prompt: "remember fact", answer: "recorded", timestamp: "2026-09-14T00:00:00Z" };
describe("provider-independent memory API", () => {
  it("rejects missing and invalid personal keys before accessing memory", async () => {
    const x = await setup({ "meta/auth/verify": { valid: false } });
    expect((await x.post("recall", { query: "q" }, "")).status).toBe(401);
    expect((await x.post("recall", { query: "q" })).status).toBe(401);
    expect(x.payloads.every(x => x.path === "meta/auth/verify")).toBe(true);
  });
  it.each([
    { "meta/agent/get": { owner_user_id: "other", team_id: "t1", status: "active" } },
    { "meta/agent/get": { owner_user_id: "u1", team_id: "other", status: "active" } },
    { "meta/team-member/get": { status: "inactive" } },
  ])("denies cross-user/team access and inactive membership", async overrides => {
    const x = await setup(overrides);
    expect((await x.post("capture", turn)).status).toBe(403);
    expect(x.payloads.some(x => x.path === "conversation/add")).toBe(false);
  });
  it("derives identity and recalls across sessions without model forwarding", async () => {
    const x = await setup();
    expect((await x.post("recall", { query: "q", user_id: "victim", session_id: "old" })).status).toBe(200);
    const reads = x.payloads.filter(x => !x.path.startsWith("meta/"));
    expect(reads.map(x => x.path).sort()).toEqual(["atomic/search", "core/read", "scenario/ls"]);
    expect(reads.every(x => x.body.user_id === "u1" && !x.body.session_id)).toBe(true);
    expect(reads.every(x => x.headers.authorization === "Bearer internal-secret")).toBe(true);
  });
  it("does not forward arbitrary paths, queries or oversized data", async () => {
    const x = await setup();
    expect((await x.post("delete", {})).status).toBe(404);
    expect((await x.post("search", { query: "x", layer: "../../meta/user/delete" })).status).toBe(400);
    expect((await x.post("recall", { query: "x", limit: 1000 })).status).toBe(400);
    expect((await x.post("recall", { query: "x", limit: 0 })).status).toBe(400);
    expect((await x.post("agents", { offset: 0, limit: 1 })).status).toBe(200);
    expect((await x.post("capture", { ...turn, answer: "x".repeat(270000) })).status).toBe(413);
  });
  it("keeps durable receipts across router restart and rejects changed payloads", async () => {
    const x = await setup();
    expect((await x.post("capture", turn)).status).toBe(200);
    const restarted = createAgentMemoryRouter(config, { fetcher: x.fetcher, receiptDir: x.receiptDir });
    const retry = await restarted.request("/capture", { method: "POST", headers: { authorization: "Bearer personal", "x-tdai-service-id": "default", "content-type": "application/json" }, body: JSON.stringify({ team_id: "t1", agent_id: "a1", ...turn }) });
    expect((await retry.json()).data.duplicate).toBe(true);
    expect((await x.post("capture", { ...turn, answer: "changed" })).status).toBe(409);
    expect(x.payloads.filter(x => x.path === "conversation/add")).toHaveLength(1);
  });
  it("does not blindly repeat a write with an uncertain outcome", async () => {
    const x = await setup({ "conversation/add": new Error("upstream timed out after commit") });
    expect((await x.post("capture", turn)).status).toBe(502);
    const retry = await x.post("capture", turn);
    expect(retry.status).toBe(409);
    expect((await retry.json()).error).toBe("capture_outcome_pending_admin_review");
    expect(x.payloads.filter(x => x.path === "conversation/add")).toHaveLength(1);
  });
  it("preserves long messages and normalizes Core timestamps", async () => {
    const x = await setup();
    const prompt = "x".repeat(8191) + "😀" + "y".repeat(9000);
    expect((await x.post("capture", { ...turn, prompt, timestamp: "2026-09-14T00:00:00+00:00" })).status).toBe(200);
    const messages = x.payloads.find(x => x.path === "conversation/add")!.body.messages;
    expect(messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("")).toBe(prompt);
    expect(messages.every((m: any) => m.content.length <= 8192 && m.timestamp.endsWith("Z"))).toBe(true);
  });
  it("checks task team and instance before performing a write", async () => {
    const x = await setup({ "meta/task/get": { team_id: "other" } });
    expect((await x.post("capture", { ...turn, task_id: "bad" })).status).toBe(403);
    expect((await x.app.request("/status", { method: "POST", headers: { authorization: "Bearer personal" }, body: "{}" })).status).toBe(403);
  });
});
