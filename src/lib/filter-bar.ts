import { FILTERS, RANGES, optionLabel, type FilterName } from "./data/filters";

// Filters as openui-lang, written from the data's own filter list (data/filters.ts), so a filter
// never offers a value the tools don't know. The plan for a dashboard (brief.ts) and the
// dataset's examples are both written with these.

const option = (value: string, label: string) =>
  `{value: ${JSON.stringify(value)}, label: ${JSON.stringify(label)}}`;

/** The date filter, with the presets the tools read as `range`. */
export const dateFilter = `DateRangeFilter($range, [${RANGES.map((range) => option(range.value, range.label)).join(", ")}], "Date range")`;

/** A filter over one dimension, with all as its first option: a dropdown, or chips. */
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
