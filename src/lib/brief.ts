import { OPTIONS_TOOL } from "./data/filters";
import { filterNamed, found, type Filter, type Found } from "./data/values";
import { OPTIONS, dateFilter, dimensionFilter, optionsQuery } from "./filter-bar";
import { follows, tools, type Current } from "./program";

// A dashboard's filters are decided before it is built: the chat model reads them off the
// request (the period, and what it splits by or narrows to) and passes them to create_dashboard.
// This turns that plan into the lines the builder gets: each filter written out, and which
// Queries pass it, worked out from the data tools' own arguments. Nothing about the filters is
// written here: which there are, their values and the periods on offer are found in the database
// (data/values.ts), the plan is checked against them, and the dashboard loads its options itself.

/** A filter a dashboard is planned with, and the value it opens on ("" or none for all). */
export type PlannedFilter = { name: string; value?: string };

type Planned = { filter: Filter; value: string };

/** The plan, each filter once: only filters the data has, opening on a value it has or on all. */
function plan(filters: readonly PlannedFilter[], data: Found): Planned[] {
  const seen = new Map<string, Planned>();
  for (const { name, value } of filters) {
    const filter = filterNamed(data, name);
    if (!filter || seen.has(name)) continue;
    const asked = (value ?? "").trim().toLowerCase();
    seen.set(name, {
      filter,
      value: filter.values.find((known) => known.toLowerCase() === asked) ?? "",
    });
  }
  return [...seen.values()];
}

/**
 * The tools that can't take an argument, so their Queries don't change with it. A tool with no
 * arguments at all, as the one that loads the filters' options, follows nothing and isn't one.
 */
const without = (argument: string) =>
  Object.entries(tools)
    .filter(([, tool]) => (tool.takes.length || tool.open) && !follows(tool, argument))
    .map(([name]) => name);

/** A filter as Queries pass it: the argument, and the variable that holds its value. */
type Wired = { argument: string; variable: string };
const wired = (name: string): Wired => ({ argument: name, variable: `$${name}` });

/** How many values still read as chips; a longer list is a dropdown. */
const CHIPS = 4;

/** The declaration and the filter itself: chips for a short list, a dropdown for a longer one. */
const written = ({ filter, value }: Planned) => [
  `$${filter.name} = ${JSON.stringify(value)}`,
  dimensionFilter(filter, filter.values.length <= CHIPS ? "ChipFilter" : "SelectFilter"),
];

/** The Query the filters' options come from, for a dashboard that has one of these filters. */
const options = (filters: readonly Filter[]) =>
  filters.length
    ? [
        optionsQuery(filters),
        `${OPTIONS} loads the filters' options from the data. It takes no arguments, and no option is written in.`,
      ]
    : [];

/**
 * Which Queries pass each filter: all of them, or all but those of the tools that can't take it,
 * which are named, so nothing is left to read off a tool's arguments.
 */
function wiring(filters: readonly Wired[]): string[] {
  const pass = ({ argument, variable }: Wired) => `${argument}: ${variable}`;
  // Filters by the tools that can't take them, so each set of tools is said once.
  const byUnable = new Map<string, Wired[]>();
  for (const filter of filters) {
    const unable = list(without(filter.argument));
    byUnable.set(unable, [...(byUnable.get(unable) ?? []), filter]);
  }
  return [...byUnable].map(([unable, group]) =>
    unable
      ? `Every Query passes ${group.map(pass).join(", ")}, except a Query of ${unable}, which can't take ${group.length > 1 ? "them" : "it"}. If the dashboard has no other Query, leave ${group.length > 1 ? "those filters" : "that filter"} out.`
      : `Every Query passes ${group.map(pass).join(", ")}.`,
  );
}

// What holds for any control. The data returns previous values for headline numbers only, and a
// Kpi shows its change with or without a compare toggle, so a toggle would change nothing.
const CONTROLS =
  "A control appears only where something changes with it. A switch for one card, such as what it is split or ranked by, goes in that Card's controls. No CompareToggle: the tools return previous values for headline numbers only, and a Kpi shows its change without one. No Query sets its own period or fixes an argument a filter in the FilterBar sets, and no title, subtitle or hint names a period: the date filter does.";

/**
 * What create_dashboard adds to its prompt: the filters planned for this dashboard. `start` is
 * the period it opens on, when the data is long enough for it.
 */
export async function dashboardBrief(
  start: string | undefined,
  filters: readonly PlannedFilter[] = [],
  data?: Found,
): Promise<string> {
  data ??= await found();
  const planned = plan(filters, data);
  const opens = data.ranges.some(({ value }) => value === start) ? start : data.opens;
  return [
    `Filters. This dashboard's filters were decided from the request, before it is built. Its FilterBar holds exactly ${planned.length ? "these, in this order" : "this one"}, written as given, and nothing else.`,
    `$range = ${JSON.stringify(opens)}`,
    dateFilter(data.ranges),
    ...planned.flatMap(written),
    ...options(planned.map(({ filter }) => filter)),
    ...wiring([wired("range"), ...planned.map(({ filter }) => wired(filter.name))]),
    CONTROLS,
  ].join("\n");
}

const list = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("");

/** A dashboard's Queries of the data tools that take arguments: what a filter could narrow. */
const narrowable = (now?: Current) =>
  (now?.queries ?? []).filter(({ tool }) => tools[tool]?.takes.length || tools[tool]?.open);

/** A change to a dashboard's filters, for the builder and for the chat model. */
export type FilterChange = {
  /** The lines edit_dashboard adds to its prompt. */
  brief: string;
  /**
   * What the chat model is told when a filter it asked for was left out: nothing on the dashboard
   * would change with it. Empty when every filter asked for went in.
   */
  leftOut: string;
};

/**
 * What edit_dashboard adds to its prompt: the filters to add or take away, then the filters the
 * dashboard has after the change and which Queries pass them, so a card the change adds follows
 * them too. `now` is the dashboard as it is (readDashboard in program.ts), when its program could
 * be read: its filters go by the variables it gave them, whatever those are named. Without it
 * only the filters being added are written out. A filter none of the dashboard's Queries can take
 * is not added: a control appears only where something changes with it.
 */
export async function filterChange(
  add: readonly PlannedFilter[] = [],
  remove: readonly string[] = [],
  now?: Current,
  data?: Found,
): Promise<FilterChange> {
  data ??= await found();
  const held = now?.bar ?? [];
  const holds = (name: string) => held.find(({ argument }) => argument === name);
  const gone = [...new Set(remove)].filter((name) => (now ? holds(name) : filterNamed(data, name)));
  const asked = plan(add, data).filter(({ filter }) => !gone.includes(filter.name));
  // A filter reaches a dashboard when one of its Queries, called as it is, changes with it.
  const calls = narrowable(now);
  const reads = [...new Set(calls.map(({ tool }) => tool))];
  const reaches = ({ filter }: Planned) =>
    !calls.length || calls.some(({ tool, args }) => follows(tools[tool]!, filter.name, args));
  const fresh = asked.filter(({ filter }) => !holds(filter.name));
  const added = fresh.filter(reaches);
  const idle = fresh.filter((planned) => !reaches(planned)).map(({ filter }) => filter);
  // A filter the bar already has can only be asked to open on a value.
  const reopened = asked.filter(({ filter, value }) => holds(filter.name) && value);
  const variable = (name: string) => holds(name)?.variable ?? `$${name}`;
  const after = [
    ...held.filter(({ argument }) => !gone.includes(argument)),
    ...added.map(({ filter }) => wired(filter.name)),
  ];
  const variables = (filters: readonly Wired[]) => list(filters.map((filter) => filter.variable));
  // The options Query is one statement, so it is written whole: for the filters being added and
  // the ones the bar keeps.
  const loaded = after.flatMap(({ argument }) => filterNamed(data, argument) ?? []);
  const idleNames = list(idle.map(({ name }) => name));
  const brief = [
    ...(idle.length
      ? [
          `No ${idleNames} filter is added: no Query on this dashboard, as it calls ${list(reads)}, can be narrowed by ${idleNames}, so nothing would change with it. The FilterBar gets no control for it.`,
        ]
      : []),
    ...(added.length
      ? [
          "Add to the FilterBar, after the filters it has, written as given:",
          ...added.flatMap(written),
          ...options(loaded),
        ]
      : []),
    ...(reopened.length
      ? [
          `The FilterBar already has ${list(reopened.map(({ filter }) => variable(filter.name)))}. Only the value it opens on changes:`,
          ...reopened.map(
            ({ filter, value }) => `${variable(filter.name)} = ${JSON.stringify(value)}`,
          ),
        ]
      : []),
    ...(gone.length
      ? [
          `Take ${list(gone.map(variable))} out: the filter in the FilterBar and that argument in every Query. No Section or Card goes with it. A declaration is dropped by setting it to null, so the patch also holds:`,
          ...gone.map((name) => `${variable(name)} = null`),
          // The options Query is left loading only the filters that stay, or goes with the last.
          ...(added.length || !now?.queries.some(({ tool }) => tool === OPTIONS_TOOL)
            ? []
            : loaded.length
              ? [optionsQuery(loaded)]
              : [`${OPTIONS} = null`]),
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
      now
        ? after.filter(({ argument }) => argument)
        : added.map(({ filter }) => wired(filter.name)),
    ),
  ].join("\n");
  return {
    brief,
    leftOut: idle.length
      ? `Not added: the ${idleNames} filter. Nothing on this dashboard would change with it: as the dashboard calls ${list(reads)}, it can't be narrowed by ${idleNames}. Say so in your reply instead of saying it was added, and that it can go in together with a view it narrows.`
      : "",
  };
}
