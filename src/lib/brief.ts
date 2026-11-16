import { dataTools } from "./data";
import { FILTERS, FILTER_NAMES, type FilterName, type RangeValue } from "./data/filters";
import { dateFilter, dimensionFilter } from "./filter-bar";

// A dashboard's filters are decided before it is built: the chat model reads them off the
// request (the period, and what it splits by or narrows to) and passes them to create_dashboard.
// This turns that plan into the lines the builder gets: each filter written out, and which
// Queries pass it, worked out from the data tools' own arguments. Nothing here names a filter, a
// tool or a value, so it reads the same over any dataset in ./data.

/** A filter a dashboard is planned with, and the value it opens on ("" or none for all). */
export type PlannedFilter = { name: FilterName; value?: string };

type Planned = { name: FilterName; value: string };

/** The plan, each filter once, opening on a value the data has or on all. */
function plan(filters: readonly PlannedFilter[]): Planned[] {
  const seen = new Map<FilterName, string>();
  for (const { name, value } of filters) {
    if (!(name in FILTERS) || seen.has(name)) continue;
    const asked = (value ?? "").trim().toLowerCase();
    seen.set(name, FILTERS[name].values.find((known) => known.toLowerCase() === asked) ?? "");
  }
  return [...seen].map(([name, value]) => ({ name, value }));
}

/** The tools that can't take an argument, so their Queries don't change with it. */
const without = (argument: string) =>
  Object.entries(dataTools)
    .filter(([, tool]) => {
      const { properties } = tool.parameters as { properties?: Record<string, unknown> };
      return !(properties && argument in properties);
    })
    .map(([name]) => name);

/** The declaration and the filter itself: chips for a short list, a dropdown for a longer one. */
const written = ({ name, value }: Planned) => [
  `$${name} = ${JSON.stringify(value)}`,
  dimensionFilter(name, FILTERS[name].values.length <= 4 ? "ChipFilter" : "SelectFilter"),
];

/** Which Queries pass each filter: all of them, or all whose tool takes it. */
function wiring(names: readonly string[]): string[] {
  const everywhere = names.filter((name) => !without(name).length);
  const lines = everywhere.length
    ? [`Every Query passes ${everywhere.map((name) => `${name}: $${name}`).join(", ")}.`]
    : [];
  for (const name of names) {
    const tools = without(name);
    if (!tools.length) continue;
    const all =
      name in FILTERS
        ? ` and says ${JSON.stringify(FILTERS[name as FilterName].all)} in its subtitle`
        : "";
    lines.push(
      `Every Query whose tool takes ${name} passes ${name}: $${name}. ${tools.join(", ")} can't take it: a card that reads only ${tools.length > 1 ? "those tools" : "that tool"} stays as it is${all}.`,
    );
  }
  return lines;
}

/** Whether a sample result holds a list of earlier values, under a key named previous or prev. */
function listsPrevious(value: unknown, under = false): boolean {
  if (Array.isArray(value)) return under || value.some((item) => listsPrevious(item));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, field]) =>
    listsPrevious(field, under || /^prev(ious)?(_|$)/i.test(key)),
  );
}

// A compare toggle draws the earlier period on charts; a Kpi shows its change with or without
// one. So it has something to change only when some tool returns earlier values as a list, the
// shape a chart reads. Tools that return them for headline numbers alone leave it nothing.
const COMPARE = Object.values(dataTools).some((tool) => listsPrevious(tool.output))
  ? "A CompareToggle goes last in the FilterBar only when a chart is given previous values: a Kpi shows its change with or without one, so previous values on Kpis alone are no reason for it."
  : "No CompareToggle: these tools return previous values for headline numbers only, and a Kpi shows its change without one.";

// What holds for any control, on any data.
const CONTROLS = `A control appears only where something changes with it. A switch for one card, such as what it is split or ranked by, goes in that Card's controls. ${COMPARE} No Query sets its own period or fixes an argument a filter in the FilterBar sets, and no title, subtitle or hint names a period: the date filter does.`;

/** What create_dashboard adds to its prompt: the filters planned for this dashboard. */
export function dashboardBrief(start: RangeValue, filters: readonly PlannedFilter[] = []): string {
  const planned = plan(filters);
  return [
    `Filters. This dashboard's filters were decided from the request, before it is built. Its FilterBar holds exactly ${planned.length ? "these, in this order" : "this one"}, written as given, and nothing else.`,
    `$range = ${JSON.stringify(start)}`,
    dateFilter,
    ...planned.flatMap(written),
    ...wiring(["range", ...planned.map(({ name }) => name)]),
    CONTROLS,
  ].join("\n");
}

/** What a change to a dashboard has to know of it: what its FilterBar sets, and its Queries. */
export type Current = { bar: string[]; queries: { name: string; tool: string }[] };

/** The source of the call that starts at `from`, up to its closing bracket. */
function call(source: string, from: number): string {
  let depth = 0;
  let quoted = false;
  for (let at = from; at < source.length; at++) {
    const char = source[at];
    if (quoted) {
      if (char === "\\") at++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return source.slice(from, at + 1);
  }
  return source.slice(from);
}

/**
 * Reads a dashboard's program: the arguments its FilterBar sets (range, and each filter in it,
 * whether written in the bar or in a statement the bar names) and which tool each Query calls.
 */
export function readDashboard(program: string): Current {
  const at = program.indexOf("FilterBar(");
  const statement = (name: string) => {
    const found = new RegExp(`^${name}[ \\t]*=[ \\t]*(?=\\w+\\()`, "m").exec(program);
    return found ? call(program, found.index + found[0].length) : name;
  };
  const bar =
    at < 0
      ? ""
      : call(program, at)
          .replace(/"(?:[^"\\]|\\.)*"/g, '""')
          .replace(/(?<![\w$.])[A-Za-z_]\w*(?![\w(])/g, statement);
  const place = (name: string) => bar.search(new RegExp(`\\$${name}\\b`));
  return {
    bar: ["range", ...FILTER_NAMES]
      .filter((name) => place(name) >= 0)
      .sort((one, other) => place(one) - place(other)),
    queries: [...program.matchAll(/^(\w+)[ \t]*=[ \t]*Query\(\s*"([^"]+)"/gm)].map(
      ([, name, tool]) => ({ name, tool }),
    ),
  };
}

const list = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("");

/**
 * What edit_dashboard adds to its prompt: the filters to add or take away, then the filters the
 * dashboard has after the change and which Queries pass them, so a card the change adds follows
 * them too. `now` is the dashboard as it is (readDashboard), when its program could be read;
 * without it only the filters being added are written out.
 */
export function filterChange(
  add: readonly PlannedFilter[] = [],
  remove: readonly FilterName[] = [],
  now?: Current,
): string {
  const held = now?.bar ?? [];
  const gone = [...new Set(remove)].filter(
    (name) => name in FILTERS && (!now || held.includes(name)),
  );
  const asked = plan(add).filter(({ name }) => !gone.includes(name));
  const added = asked.filter(({ name }) => !held.includes(name));
  // A filter the bar already has can only be asked to open on a value.
  const reopened = asked.filter(({ name, value }) => held.includes(name) && value);
  const after = [
    ...held.filter((name) => !gone.some((left) => left === name)),
    ...added.map(({ name }) => name),
  ];
  const variables = (names: readonly string[]) => list(names.map((name) => `$${name}`));
  // The dashboard's own Queries that an added filter can't reach, by name.
  const unreached = added.flatMap(({ name }) => {
    const tools = without(name);
    const queries = (now?.queries ?? []).filter(({ tool }) => tools.includes(tool));
    return queries.length
      ? [
          `Here ${list(queries.map((query) => query.name))} can't take ${name}: add ${JSON.stringify(FILTERS[name].all)} to the subtitle of every Card that reads nothing else.`,
        ]
      : [];
  });
  return [
    ...(added.length
      ? [
          "Add to the FilterBar, after the filters it has and before any CompareToggle, written as given:",
          ...added.flatMap(written),
        ]
      : []),
    ...(reopened.length
      ? [
          `The FilterBar already has ${variables(reopened.map(({ name }) => name))}. Only the value it opens on changes:`,
          ...reopened.map(({ name, value }) => `$${name} = ${JSON.stringify(value)}`),
        ]
      : []),
    ...(gone.length
      ? [
          `Take ${variables(gone)} out: the filter in the FilterBar and that argument in every Query. No Section or Card goes with it. A declaration is dropped by setting it to null, so the patch also holds:`,
          ...gone.map((name) => `$${name} = null`),
        ]
      : []),
    ...(now && after.length
      ? [
          added.length || gone.length
            ? `After this change the FilterBar's filters are ${variables(after)}, and no others.`
            : `The FilterBar keeps its filters as they are: ${variables(after)}.`,
          "For the Queries already there and any this change adds:",
        ]
      : []),
    ...wiring(now ? after : added.map(({ name }) => name)),
    ...unreached,
  ].join("\n");
}
