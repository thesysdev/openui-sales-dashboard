import { OpenUIApiError } from "@openuidev/server";
import { encode } from "gpt-tokenizer";
import type { NextRequest } from "next/server";
import { openui } from "../../../lib/openui";
import { noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

// How many fewer tokens the model spent writing a dashboard in OpenUI Lang than the HTML it
// renders to. Same method as OpenUI's GitHub dashboard demo (gpt-tokenizer, percent saved vs
// the bulkier format), with rendered HTML as the baseline instead of JSON. The browser sends
// the dashboard's HTML; the program comes from OpenUI Cloud.

// A dashboard's HTML with its chart internals collapsed is well under this. Counting tokens is CPU
// work and the route needs no sign-in, so a bigger body is refused.
const MAX_HTML = 300_000;

export async function POST(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  const { id, html } = (await request.json().catch(() => ({}))) as { id?: unknown; html?: unknown };
  if (typeof id !== "string" || !/^art_[A-Za-z0-9_-]+$/.test(id)) {
    return Response.json({ error: "Bad dashboard id" }, { status: 400 });
  }
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_HTML) {
    return Response.json({ error: "Bad html" }, { status: 400 });
  }

  // Read as the visitor, so only their own dashboards come back.
  let content: string;
  try {
    ({ content } = await openui.artifacts.get(id, { userId: visitor, signal: request.signal }));
  } catch (error) {
    if (!(error instanceof OpenUIApiError)) throw error;
    return Response.json(
      { error: `Dashboard not found (${error.status ?? error.code})` },
      { status: 404 },
    );
  }
  if (!content) {
    return Response.json({ error: "Dashboard has no program yet" }, { status: 409 });
  }

  const langTokens = encode(content).length;
  const htmlTokens = encode(html).length;
  const pct =
    htmlTokens > langTokens ? Math.round(((htmlTokens - langTokens) / htmlTokens) * 100) : 0;
  return Response.json({ langTokens, htmlTokens, pct });
}
