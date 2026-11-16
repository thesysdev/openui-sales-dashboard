import { parseMessage } from "@openuidev/lang-core";
import { OpenUIApiError } from "@openuidev/server";
import type { NextRequest } from "next/server";
import { checkProgram, repairPrompt } from "../../../lib/check";
import { baseUrl, dashboards, openui } from "../../../lib/openui";
import { noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

// Checks a dashboard's filters once a version of it is whole (src/lib/check.ts), and repairs it
// when a filter or a switch changes nothing: the problems go to the builder as one exact edit.
// The browser calls this each time a dashboard settles; the program comes from OpenUI Cloud.

// The request is a dashboard's id and a flag. A repair is a full generation on the API key and
// the route needs no sign-in, so a bigger body is refused.
const MAX_BODY = 1_000;

// One repair for each version the user or the chat made, and none for a version a repair made.
// So for each dashboard this keeps the version that was repaired and the version the repair
// made, and neither is repaired again. It is this server's memory only, so the browser also
// says when the version it shows came from a repair. Kept on globalThis because Next.js dev
// gives a recompiled route a new module instance.
type Repair = { from: string; made?: string };
const repairs = ((globalThis as Record<string, unknown>).__filterRepairs ??= new Map()) as Map<
  string,
  Repair
>;
const MAX_REPAIRS = 2_000;

// Only a version made just now is repaired. Opening an older dashboard checks it and changes
// nothing: its owner didn't ask for it to change.
const FRESH_MS = 10 * 60_000;

export async function POST(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  const raw = await request.text();
  let body: { id?: unknown; repaired?: unknown } = {};
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
  const found = checkProgram(program);
  const problems = found.filter((problem) => problem.kind !== "fixed");
  const fixes = problems.map((problem) => problem.fix);
  if (!problems.length) return Response.json({ problems: found.map((problem) => problem.fix) });
  const fresh =
    typeof artifact.updated_at === "number" && Date.now() - artifact.updated_at * 1000 < FRESH_MS;

  // The version, or without one the program itself, so a changed program is a new version.
  const version = typeof artifact.version === "string" ? artifact.version : program;
  const repair = repairs.get(id);
  // The first new version after a repair whose version wasn't told is the one it made.
  if (repair && !repair.made && version !== repair.from) repair.made = version;
  if (!fresh || body.repaired === true || version === repair?.from || version === repair?.made) {
    if (fresh && version !== repair?.from) {
      console.warn(`Dashboard ${id} still fails its check`, fixes);
    }
    return Response.json({ problems: fixes });
  }

  try {
    const started = await dashboards.edit(
      { id, prompt: repairPrompt(problems) },
      { userId: visitor },
      { signal: request.signal },
    );
    // Its response names the version it makes.
    repairs.delete(id);
    repairs.set(id, { from: version, made: parseMessage(started).attributes.version });
    if (repairs.size > MAX_REPAIRS) repairs.delete(repairs.keys().next().value!);
    // The renderer takes the response as is, as it does an edit_dashboard result.
    return Response.json({ problems: fixes, repair: started });
  } catch (error) {
    const status = error instanceof OpenUIApiError ? (error.status ?? 500) : 500;
    return Response.json({ error: "OpenUI Cloud could not start the repair." }, { status });
  }
}
