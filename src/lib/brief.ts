import { dataset, type Current } from "./check";
import { dataTools } from "./data";
import { FILTERS, type FilterName, type RangeValue } from "./data/filters";
import { dateFilter, dimensionFilter } from "./filter-bar";

// A dashboard's filters are decided before it is built: the chat model reads them off the
// request (the period, and what it splits by or narrows to) and passes them to create_dashboard.
// This turns that plan into the lines the builder gets: each filter written out, and which
// Queries pass it, worked out from the data tools' own arguments. Nothing here names a filter, a
// tool or a value, so it reads the same over any dataset in ./data.

/** A filter a dashboard is planned with, and the value it opens on ("" or none for all). */
export type PlannedFilter = { name: FilterName; value?: string };

/** `reset` says all was asked for by name ("" or the filter's label for all): an edit can set a
 * filter back to it. A value the data doesn't have is not that: it opens a new filter on all and
 * leaves one already there as it is. */
type Planned = { name: FilterName; value: string; reset: boolean };

/** A value as it is matched: letters and digits only, so "paid_social" finds "Paid social". */
const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The plan, each filter once, opening on a value the data has or on all. */
function plan(filters: readonly PlannedFilter[]): Planned[] {
  const seen = new Map<FilterName, Planned>();
  for (const { name, value } of filters) {
    if (!Object.hasOwn(FILTERS, name) || seen.has(name)) continue;
    const asked = plain(value ?? "");
    seen.set(name, {
      name,
      value: FILTERS[name].values.find((known) => plain(known) === asked) ?? "",
      reset:
        value !== undefined && ["", "all", plain(FILTERS[name].all)].some((all) => all === asked),
    });
  }
  return [...seen.values()];
}

/** The tools that can't take an argument, so their Queries don't change with it. */
const without = (argument: string) =>
  Object.entries(dataset.tools)
    .filter(([, tool]) => !tool.takes.includes(argument))
    .map(([name]) => name);

/** A filter as Queries pass it: the argument, and the variable that holds its value. */
type Wired = { argument: string; variable: string };
const wired = (name: string): Wired => ({ argument: name, variable: `$${name}` });

/** The declaration and the filter itself: chips for a short list, a dropdown for a longer one. */
const written = ({ name, value }: Pick<Planned, "name" | "value">) => [
  `$${name} = ${JSON.stringify(value)}`,
  dimensionFilter(name, FILTERS[name].values.length <= 4 ? "ChipFilter" : "SelectFilter"),
];

/** What a card says when it can't follow a filter: the filter's label for all, in its subtitle. */
const saysAll = (argument: string) =>
  argument in FILTERS
    ? ` and says ${JSON.stringify(FILTERS[argument as FilterName].all)} in its subtitle`
    : "";

/**
 * Which Queries pass each filter: all of them, or all whose tool takes it, and never a call the
 * data says doesn't follow it (a tool's `ignores`). So the builder isn't told to pass a filter
 * into a call that would drop it.
 */
function wiring(filters: readonly Wired[]): string[] {
  const pass = ({ argument, variable }: Wired) => `${argument}: ${variable}`;
  const lines: string[] = [];
  const exceptions: string[] = [];
  for (const filter of filters) {
    const tools = without(filter.argument);
    if (tools.length) {
      lines.push(
        `Every Query whose tool takes ${filter.argument} passes ${pass(filter)}. ${tools.join(", ")} can't take it: a card that reads only ${tools.length > 1 ? "those tools" : "that tool"} stays as it is${saysAll(filter.argument)}. If no Query on the dashboard takes it, leave the filter out.`,
      );
    }
    for (const [tool, { ignores }] of Object.entries(dataset.tools)) {
      for (const [other, values] of Object.entries(ignores?.[filter.argument] ?? {})) {
        exceptions.push(
          `A ${tool} call with ${other} ${values.map((value) => JSON.stringify(value)).join(" or ")} doesn't follow ${filter.argument}: leave ${filter.argument} out of it, and a card that reads only such calls stays as it is${saysAll(filter.argument)}.`,
        );
      }
    }
  }
  const everywhere = filters.filter(({ argument }) => !without(argument).length);
  return [
    ...(everywhere.length
      ? [
          `Every Query passes ${everywhere.map(pass).join(", ")}${exceptions.length ? ", but for the calls named below" : ""}.`,
        ]
      : []),
    ...lines,
    ...exceptions,
  ];
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
    ...wiring([wired("range"), ...planned.map(({ name }) => wired(name))]),
    CONTROLS,
  ].join("\n");
}

const list = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("");

/**
 * What edit_dashboard adds to its prompt: the filters to add or take away, then the filters the
 * dashboard has after the change and which Queries pass them, so a card the change adds follows
 * them too. `now` is the dashboard as it is (readDashboard in check.ts), when its program could
 * be read: its filters go by the variables it gave them, whatever those are named. Without it
 * only the filters being added are written out.
 */
export function filterChange(
  add: readonly PlannedFilter[] = [],
  remove: readonly FilterName[] = [],
  now?: Current,
): string {
  const held = now?.bar ?? [];
  const holds = (name: string) => held.find(({ argument }) => argument === name);
  const gone = [...new Set(remove)].filter((name) => name in FILTERS && (!now || holds(name)));
  const asked = plan(add).filter(({ name }) => !gone.includes(name));
  const added = asked.filter(({ name }) => !holds(name));
  // A filter the bar already has can only be asked to open on a value, or on all again.
  const reopened = asked.filter(({ name, value, reset }) => holds(name) && (value || reset));
  const variable = (name: string) => holds(name)?.variable ?? `$${name}`;
  const after = [
    ...held.filter(({ argument }) => !gone.some((name) => name === argument)),
    ...added.map(({ name }) => wired(name)),
  ];
  const variables = (filters: readonly Wired[]) => list(filters.map((filter) => filter.variable));
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
          `The FilterBar already has ${list(reopened.map(({ name }) => variable(name)))}. Only the value it opens on changes:`,
          ...reopened.map(({ name, value }) => `${variable(name)} = ${JSON.stringify(value)}`),
        ]
      : []),
    ...(gone.length
      ? [
          `Take ${list(gone.map(variable))} out: the filter in the FilterBar and that argument in every Query. No Section or Card goes with it. A declaration is dropped by setting it to null, so the patch also holds:`,
          ...gone.map((name) => `${variable(name)} = null`),
        ]
      : []),
    // A change to the filters rewires the Queries already there. Any other change leaves them
    // as they are and only says what a card it adds follows, unless it asks for something else
    // (a card fixed to one period, a filter this tool has no argument for).
    ...(now && after.length
      ? added.length || gone.length
        ? [
            `After this change the FilterBar's filters are ${variables(after)}, and no others.`,
            "For the Queries already there and any this change adds:",
          ]
        : [
            `Unless the change says otherwise, the FilterBar keeps its filters, ${variables(after)}, and a card the change adds follows them:`,
          ]
      : []),
    // A control no Query passes, such as a switch read on the page, has no wiring to restate.
    ...wiring(
      now ? after.filter(({ argument }) => argument) : added.map(({ name }) => wired(name)),
    ),
    ...unreached,
  ].join("\n");
}
