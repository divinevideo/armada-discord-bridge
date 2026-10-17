import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { authenticateReport, type Reports } from "./reports";
import { DecisionRefusedError, type Decisions, type VerifiedCoopActor } from "./decisions";
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const signature = (key: Uint8Array, method: string, path: string, body: string, timestamp: string, actor: string) => createHmac("sha256", key).update(JSON.stringify([method, path, digest(body), timestamp, actor])).digest("hex");
/** Coop signs its server-derived staff identity after its own permission check. */
export function signCoopRequest(key: Uint8Array, actor: VerifiedCoopActor, method: string, path: string, body: string, now = Math.floor(Date.now() / 1000)): Record<string, string> {
  const encoded = Buffer.from(JSON.stringify(actor)).toString("base64"), timestamp = String(now);
  return { "content-type": "application/json", "x-coop-actor": encoded, "x-coop-timestamp": timestamp, "x-coop-signature": signature(key, method, path, body, timestamp, encoded) };
}
function authenticateCoop(request: Request, body: string, key: Uint8Array, orgs: ReadonlySet<string>): VerifiedCoopActor {
  const encoded = request.headers.get("x-coop-actor") ?? "", timestamp = request.headers.get("x-coop-timestamp") ?? "", provided = request.headers.get("x-coop-signature") ?? "";
  if (encoded.length > 4096 || !/^[0-9]{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 || !/^[0-9a-f]{64}$/.test(provided)) throw new Error("Invalid staff authentication");
  const url = new URL(request.url), expected = signature(key, request.method, url.pathname + url.search, body, timestamp, encoded);
  if (!timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"))) throw new Error("Invalid staff authentication");
  const actor = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!orgs.has(actor.orgId) || typeof actor.actorId !== "string" || !actor.actorId || actor.actorId.length > 128 || !Array.isArray(actor.permissions) || actor.permissions.length > 16 || !actor.permissions.every((p: unknown) => typeof p === "string" && p.length <= 64)) throw new Error("Invalid staff identity");
  return actor;
}
async function boundedBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length")) > 65_536) throw new Error("oversized");
  if (!request.body) return "";
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  // A byte cap alone lets a slow anonymous sender retain pre-auth work forever.
  // Cancel the reader itself, not just a race that leaves reads running behind it.
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 1500);
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (expired) throw new Error("body deadline");
      if (next.done) break;
      length += next.value.length;
      if (length > 65_536) { void reader.cancel().catch(() => {}); throw new Error("oversized"); }
      chunks.push(next.value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
export function createModerationApi(options: { publicOrigin: string; allowedReportOrigins?: ReadonlySet<string>; coopSecret: Uint8Array; orgs: ReadonlySet<string>; reports: Pick<Reports, "submitReport"> & Partial<Pick<Reports, "getCase">>; decisions: Pick<Decisions, "acceptDecision" | "get" | "retry"> & Partial<Pick<Decisions, "forCase">> }) {
  if (options.coopSecret.length < 32) throw new Error("Staff service credential required");
  const capacity = () => {
    let remaining = 100, window = Date.now();
    return () => {
      if (Date.now() - window >= 1000) { remaining = 100; window = Date.now(); }
      return --remaining >= 0;
    };
  };
  const reportCapacity = capacity(), staffCapacity = capacity();
  const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname;
    const caseRoute = /^\/v1\/cases\/([0-9a-f-]{36})$/.exec(path);
    const decisionRoute = /^\/v1\/decisions\/([0-9a-f-]{36})(\/retry)?$/.exec(path);
    if (path !== "/v1/reports" && path !== "/v1/decisions" && !decisionRoute && !caseRoute) return response({ error: "not_found" }, 404);
    // Neither public reports nor forged staff headers spend authenticated staff
    // capacity. Keep the existing 100/s cap independently for each trust domain.
    if (path === "/v1/reports" && !reportCapacity()) return response({ error: "rate_limited" }, 429);
    let body: string;
    try { body = await boundedBody(request); } catch { return response({ error: "request_too_large" }, 413); }
    if (path === "/v1/reports") {
      if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
      let reporter;
      try { reporter = await authenticateReport(request, body, options.publicOrigin); } catch { return response({ error: "authentication_required" }, 401); }
      try { return response(await options.reports.submitReport(JSON.parse(body), reporter), 202); }
      catch { return response({ error: "report_not_accepted" }, 400); }
    }
    let actor;
    try { actor = authenticateCoop(request, body, options.coopSecret, options.orgs); } catch { return response({ error: "staff_authorization_required" }, 403); }
    if (!staffCapacity()) return response({ error: "rate_limited" }, 429);
    try {
      if (caseRoute && request.method === "GET" && options.reports.getCase && options.decisions.forCase) {
        const decisions = await options.decisions.forCase(caseRoute[1], actor);
        try { return response({ ...await options.reports.getCase(caseRoute[1], actor), evidenceAvailable: true, decisions }); }
        catch { if (!decisions.length) throw new Error("Case unavailable"); return response({ caseId: caseRoute[1], evidenceAvailable: false, content: null, reason: null, expiresAt: null, decisions }); }
      }
      if (path === "/v1/decisions" && request.method === "POST") return response(await options.decisions.acceptDecision(JSON.parse(body), actor), 202);
      if (decisionRoute && !decisionRoute[2] && request.method === "GET") return response(await options.decisions.get(decisionRoute[1], actor));
      if (decisionRoute?.[2] && request.method === "POST") return response(await options.decisions.retry(decisionRoute[1], actor), 202);
      return response({ error: "method_not_allowed" }, 405);
    } catch (error) {
      // A refusal staff can resolve (act on the newer decision) names itself.
      // Everything else stays opaque.
      if (error instanceof DecisionRefusedError) return response({ error: error.code }, 409);
      return response({ error: "decision_not_accepted" }, 400);
    }
  };
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (new URL(request.url).pathname !== "/v1/reports" || !origin) return handle(request);
    if (!options.allowedReportOrigins?.has(origin)) return response({ error: "origin_not_allowed" }, 403);
    const result = request.method === "OPTIONS"
      ? new Response(null, { status: 204 }) : await handle(request);
    result.headers.set("access-control-allow-origin", origin);
    result.headers.set("vary", "Origin");
    result.headers.set("access-control-allow-methods", "POST");
    result.headers.set("access-control-allow-headers", "Authorization, Content-Type");
    result.headers.set("cache-control", "no-store");
    return result;
  };

}
