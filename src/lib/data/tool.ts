import type { DataTool } from "@openuidev/server";
import { z } from "zod";

/**
 * A data tool. `parameters` describes the arguments for generation; `output` is an example
 * result, so generated dashboards know the shape of the data (static, so defining the tools
 * never calls the network); `run` reads its arguments leniently (see fetch.ts).
 *
 * `parameters` can be a function, for arguments whose choices come from the data: it is read
 * again each time a dashboard is generated, so the choices are the ones the data has then.
 */
export function dataTool(
  description: string,
  parameters: z.ZodObject | (() => z.ZodObject),
  output: unknown,
  run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
): DataTool {
  return {
    description,
    get parameters() {
      return z.toJSONSchema(typeof parameters === "function" ? parameters() : parameters);
    },
    output,
    execute: (args, _context, { signal }) => run(args ?? {}, signal),
  };
}
