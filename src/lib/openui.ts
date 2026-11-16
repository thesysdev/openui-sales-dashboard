import { promptOptions } from "@openuidev/dashboard-library";
import { OpenUIClient } from "@openuidev/server";
import spec from "../generated/spec.json";
import { dataTools } from "./data";
import { builderAbout } from "./data/about";
import { examples } from "./data/examples";
import { currentVisitor } from "./visitor";

// OpenUI Cloud, or your own deployment of it, such as a local stack at http://localhost:3102.
export const baseUrl = (process.env.THESYS_BASE_URL || "https://api.thesys.dev").replace(
  /\/+$/,
  "",
);

// Reads THESYS_API_KEY when it makes a request.
export const openui = new OpenUIClient({ baseUrl });

// Dashboards belong to the visitor the work runs for (src/lib/visitor.ts), so each visitor
// lists, opens and edits only their own.
export function userId(): string {
  const id = currentVisitor();
  if (!id) throw new Error("No visitor: run this inside asVisitor()");
  return id;
}

// One definition for every dashboard: the components it's built from, the model that builds
// it, and where its data comes from: the data tools in ./data. Its interpreter runs those tools
// for the browser.
export const dashboards = openui.defineDashboard({
  // The specification `npm run generate` writes from src/library.ts, so the server never loads
  // the React components the browser renders with.
  library: spec,
  model: process.env.OPENUI_DASHBOARD_MODEL || "anthropic/claude-sonnet-5.5",
  tools: dataTools,
  // The kit's rules, with our own preamble and examples.
  promptOptions: {
    // Whose data it is, from the dataset, then what holds for a dashboard over any data.
    preamble: `${builderAbout} Every number is loaded by Query() each time the dashboard opens, so none is written in: no sample data, no target or threshold a tool doesn't return. The request says what the reader wants to learn; the design is yours. Use the whole component library to make the answer clear at a glance, add what else the data tools hold that helps read it, and follow with the detail. A chart's labels and values are columns read off a list (rows.period, rows.value), never the list of rows itself.`,
    // The dataset's own, in place of the kit's generic ones. They show how the data is wired,
    // not what a dashboard looks like.
    examples,
    additionalRules: promptOptions.additionalRules,
  },
});
