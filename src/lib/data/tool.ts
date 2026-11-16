import type { DataTool } from "@openuidev/server";
import { z } from "zod";
import type { Ignores } from "../check";

/**
 * A data tool. `parameters` describes the arguments for generation; `output` is an example
 * result, so generated dashboards know the shape of the data (static, so defining the tools
 * never calls the network); `run` reads its arguments leniently (see fetch.ts). `ignores` names
 * the arguments some of its calls don't follow, for the dashboard check (../check.ts);
 * generation doesn't see it.
 */
export function dataTool(
  description: string,
  parameters: z.ZodObject,
  output: unknown,
  run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
  ignores?: Ignores,
): DataTool & { ignores?: Ignores } {
  return {
    description,
    parameters: z.toJSONSchema(parameters),
    output,
    execute: (args, _context, { signal }) => run(args ?? {}, signal),
    ignores,
  };
}
