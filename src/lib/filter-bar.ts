import { FILTERS, RANGES, optionLabel, type FilterName, type RangeValue } from "./data/filters";

// Filters as openui-lang, with the values the data tools read. The example dashboards are
// written with these, so what the builder learns from never offers a value the tools don't know.
// Which filters a new dashboard gets is the builder's choice: dashboardBrief only says where the
// date filter starts and what a filter has to do.

const option = (value: string, label: string) =>
  `{value: ${JSON.stringify(value)}, label: ${JSON.stringify(label)}}`;

/** The date filter, with the presets the tools read as `range`. */
export const dateFilter = `DateRangeFilter($range, [${RANGES.map((range) => option(range.value, range.label)).join(", ")}], "Date range")`;

/** A filter over one dimension that opens on all: a dropdown, or chips for a short list. */
export function dimensionFilter(
  name: FilterName,
  kind: "SelectFilter" | "ChipFilter" = "SelectFilter",
): string {
  const { label, all, values } = FILTERS[name];
  const options = [option("", all), ...values.map((value) => option(value, optionLabel(value)))];
  return `${kind}($${name}, [${options.join(", ")}], ${JSON.stringify(label)})`;
}

/** The arguments that make a Query follow the filters: `range: $range, region: $region`. */
export const filterArgs = (names: readonly FilterName[]) =>
  ["range: $range", ...names.map((name) => `${name}: $${name}`)].join(", ");

/**
 * What create_dashboard adds to its prompt: what the filters have to do, and nothing about how
 * the dashboard looks. Which filters, which charts and what layout are the builder's choice.
 */
export function dashboardBrief(start: RangeValue): string {
  return [
    `Filters. Choose them for what this dashboard shows. The date filter starts at $range = ${JSON.stringify(start)}. Add the others a reader of these cards would reach for, out of the arguments the tools take: a region, category, brand or channel to narrow by, or a choice such as what to rank by. One that changes the whole dashboard goes in the FilterBar, one that changes a single card in that Card's controls. Options are the values the tool lists.`,
    "Every Query passes range: $range and each other filter's variable its tool takes. Leave out a filter or a card's switch that no Query or chart would read. No Query sets its own period, and no title, subtitle or hint names one: the date filter does.",
  ].join("\n");
}
