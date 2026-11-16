import { parseMessage } from "@openuidev/lang-core";
import { OpenUIApiError } from "@openuidev/server";
import type { NextRequest } from "next/server";
import { checkProgram, repairPrompt } from "../../../lib/check";
import { baseUrl, dashboards, openui } from "../../../lib/openui";
import { noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

// Checks a dashboard's filters once a version of it is whole (src/lib/check.ts), and repairs it
// when a filter or a switch changes nothing: the problems go to the builder as one exact edit.
// The browser calls this when a version made while the user watches settles; the program comes
// from OpenUI Cloud.

// The request is a dashboard's id. A repair is a full generation on the API key and the route
// needs no sign-in, so a bigger body is refused.
const MAX_BODY = 1_000;

// One repair for each version the user or the chat made, and none for a version a repair made.
// So for each dashboard this keeps the version being repaired and the version the repair makes,
// and neither is repaired again. The record is written before the repair is started, so requests
// that arrive together start one. It is this server's memory only: run on several instances, each
// keeps its own, and a shared store is needed for the limit to hold across them (see the README's
// notes on deploying). Kept on globalThis because Next.js dev gives a recompiled route a new
// module instance.
type Repair = { from: string; made?: string };
const repairs = ((globalThis as Record<string, unknown>).__filterRepairs ??= new Map()) as Map<
  string,
  Repair
>;
const MAX_REPAIRS = 2_000;

// Only a version made just now is repaired. An older dashboard is checked and left as it is:
// its owner didn't ask for it to change. The age is taken either way round, so a clock that
// runs behind OpenUI Cloud's doesn't make every dashboard look new.
const FRESH_MS = 10 * 60_000;

export async function POST(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  const raw = await request.text();
  let body: { id?: unknown } = {};
  try {
    if (raw.length <= MAX_BODY) body = JSON.parse(raw) ?? {};
  } catch {
    // Answered below, like a body that's too large.
  }
  const { id } = body;
  if (typeof id !== "string" || !/^art_[A-Za-z0-9_-]+$/.test(id)) {
    return Response.json({ error: "Bad dashboard id" }, { status: 400 });
  }

  // The frontend token reads only this visitor's dashboards.
  const { token } = await openui.createFrontendToken({ userId: visitor });
  const response = await fetch(`${baseUrl}/v1/artifacts/${encodeURIComponent(id)}`, {
    headers: { "x-thesys-frontend-token": token },
    signal: request.signal,
  });
  if (!response.ok) {
    return Response.json({ error: `Dashboard not found (${response.status})` }, { status: 404 });
  }
  const artifact = (await response.json()) as {
    content?: unknown;
    version?: unknown;
    updated_at?: unknown;
  };
  const program = typeof artifact.content === "string" ? artifact.content : "";
  if (!parseMessage(program).end) {
    return Response.json({ error: "Dashboard has no whole program yet" }, { status: 409 });
  }

  // A Query that sets a filter's argument itself may be what the user asked for ("a card that
  // always shows one region"), and the card says which value it shows, so it is reported and
  // left as it is. What is repaired is a card that silently ignores a filter, a control that
  // changes nothing, and a card that can't follow a filter without saying so.
  let found: ReturnType<typeof checkProgram>;
  try {
    found = checkProgram(program);
  } catch {
    // A program the check can't follow, such as statements that name each other in a circle.
    return Response.json({ problems: [] });
  }
  const problems = found.filter((problem) => problem.kind !== "fixed");
  const fixes = problems.map((problem) => problem.fix);
  if (!problems.length) return Response.json({ problems: found.map((problem) => problem.fix) });
  const fresh =
    typeof artifact.updated_at === "number" &&
    Math.abs(Date.now() - artifact.updated_at * 1000) < FRESH_MS;

  // The version, or without one the program itself, so a changed program is a new version.
  const version = typeof artifact.version === "string" ? artifact.version : program;
  const before = repairs.get(id);
  // The first new version after a repair whose version isn't known yet is the one it made.
  if (before && !before.made && version !== before.from) before.made = version;
  if (!fresh || version === before?.from || version === before?.made) {
    return Response.json({ problems: fixes });
  }

  // Recorded before the repair starts: a request that arrives meanwhile finds it and stops.
  const repair: Repair = { from: version };
  repairs.delete(id);
  repairs.set(id, repair);
  if (repairs.size > MAX_REPAIRS) repairs.delete(repairs.keys().next().value!);
  try {
    // Not tied to the request: the browser leaving shouldn't stop a repair it can't see ended.
    const started = await dashboards.edit(
      { id, prompt: repairPrompt(problems) },
      { userId: visitor },
    );
    // Its response names the version it makes.
    repair.made ??= parseMessage(started).attributes.version;
    // The renderer takes the response as is, as it does an edit_dashboard result.
    return Response.json({ problems: fixes, repair: started });
  } catch (error) {
    // Nothing was started, so this version can be tried again.
    if (repairs.get(id) === repair) repairs.delete(id);
    const status = error instanceof OpenUIApiError ? (error.status ?? 500) : 500;
    return Response.json({ error: "OpenUI Cloud could not start the repair." }, { status });
  }
}
