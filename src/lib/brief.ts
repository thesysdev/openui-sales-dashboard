import { FILTERS, type FilterName, type RangeValue } from "./data/filters";
import { dateFilter, dimensionFilter } from "./filter-bar";
import { dataset, type Current } from "./program";

// A dashboard's filters are decided before it is built: the chat model reads them off the
// request (the period, and what it splits by or narrows to) and passes them to create_dashboard.
// This turns that plan into the lines the builder gets: each filter written out, and which
// Queries pass it, worked out from the data tools' own arguments.

/** A filter a dashboard is planned with, and the value it opens on ("" or none for all). */
export type PlannedFilter = { name: FilterName; value?: string };

type Planned = { name: FilterName; value: string };

/** The plan, each filter once, opening on a value the data has or on all. */
function plan(filters: readonly PlannedFilter[]): Planned[] {
  const seen = new Map<FilterName, string>();
  for (const { name, value } of filters) {
    if (!Object.hasOwn(FILTERS, name) || seen.has(name)) continue;
    const asked = (value ?? "").trim().toLowerCase();
    seen.set(name, FILTERS[name].values.find((known) => known.toLowerCase() === asked) ?? "");
  }
  return [...seen].map(([name, value]) => ({ name, value }));
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
const written = ({ name, value }: Planned) => [
  `$${name} = ${JSON.stringify(value)}`,
  dimensionFilter(name, FILTERS[name].values.length <= 4 ? "ChipFilter" : "SelectFilter"),
];

/** Which Queries pass each filter: all of them, or all whose tool takes it. */
function wiring(filters: readonly Wired[]): string[] {
  const pass = ({ argument, variable }: Wired) => `${argument}: ${variable}`;
  const everywhere = filters.filter(({ argument }) => !without(argument).length);
  return [
    ...(everywhere.length ? [`Every Query passes ${everywhere.map(pass).join(", ")}.`] : []),
    ...filters.flatMap((filter) => {
      const tools = without(filter.argument);
      return tools.length
        ? [
            `Every Query whose tool takes ${filter.argument} passes ${pass(filter)}. ${tools.join(", ")} can't take it. If no Query on the dashboard takes it, leave the filter out.`,
          ]
        : [];
    }),
  ];
}

// What holds for any control. The data returns previous values for headline numbers only, and a
// Kpi shows its change with or without a compare toggle, so a toggle would change nothing.
const CONTROLS =
  "A control appears only where something changes with it. A switch for one card, such as what it is split or ranked by, goes in that Card's controls. No CompareToggle: the tools return previous values for headline numbers only, and a Kpi shows its change without one. No Query sets its own period or fixes an argument a filter in the FilterBar sets, and no title, subtitle or hint names a period: the date filter does.";

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
 * them too. `now` is the dashboard as it is (readDashboard in program.ts), when its program could
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
  const gone = [...new Set(remove)].filter(
    (name) => Object.hasOwn(FILTERS, name) && (!now || holds(name)),
  );
  const asked = plan(add).filter(({ name }) => !gone.includes(name));
  const added = asked.filter(({ name }) => !holds(name));
  // A filter the bar already has can only be asked to open on a value.
  const reopened = asked.filter(({ name, value }) => holds(name) && value);
  const variable = (name: string) => holds(name)?.variable ?? `$${name}`;
  const after = [
    ...held.filter(({ argument }) => !gone.some((name) => name === argument)),
    ...added.map(({ name }) => wired(name)),
  ];
  const variables = (filters: readonly Wired[]) => list(filters.map((filter) => filter.variable));
  return [
    ...(added.length
      ? [
          "Add to the FilterBar, after the filters it has, written as given:",
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
  ].join("\n");
}
