import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { firstMonth, found, type Found } from "../../../lib/data/values";
import { baseUrl } from "../../../lib/openui";

export const runtime = "nodejs";

// What the data can be split by and where it starts are found in the database (lib/data/values.ts).
const system = (
  data?: Found,
) => `You suggest the next questions for a sales analytics chat. Northstar is a multi-brand apparel, footwear and accessories retailer; the assistant builds live dashboards from its sales database: net sales, trends, breakdowns${data ? ` by ${data.filters.map(({ label }) => label.toLowerCase()).join(", ")}` : ""}, top products, returns, targets vs actuals, new vs returning customers, and promotions. Data runs ${data ? `from ${firstMonth(data)} ` : ""}to the latest order, in USD.

Given the conversation, reply with ONLY a JSON array of 3 very short follow-up requests the user would plausibly send next. Build on the latest dashboard (drill down, compare, add a view, change the range) or pivot to a related question. Each 3 to 6 words, like a button label ("Split by region", "Add margin trend"), no numbers, no trailing punctuation.`;

/** 3 follow-up prompts for the conversation so far, from a small gateway call. */
export async function POST(request: Request) {
  const { transcript } = (await request.json()) as { transcript?: string };
  const apiKey = process.env.THESYS_API_KEY;
  // Failures answer with an error status, which the chat ignores: follow-ups are a nicety.
  if (!transcript?.trim()) return Response.json({ suggestions: [] }, { status: 400 });
  if (!apiKey) return Response.json({ suggestions: [] }, { status: 500 });

  const gateway = createOpenAI({ apiKey, baseURL: `${baseUrl}/v1/embed` });
  try {
    const { text } = await generateText({
      model: gateway.chat(
        process.env.OPENUI_FOLLOWUPS_MODEL ||
          process.env.OPENUI_MODEL ||
          "anthropic/claude-sonnet-5.5",
      ),
      system: system(await found().catch(() => undefined)),
      prompt: transcript.slice(-4000),
      abortSignal: request.signal,
    });
    const parsed: unknown = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    const suggestions = (Array.isArray(parsed) ? parsed : [])
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 3);
    return Response.json({ suggestions });
  } catch {
    // Follow-ups are a nicety; never surface their failures in the chat.
    return Response.json({ suggestions: [] }, { status: 502 });
  }
}
