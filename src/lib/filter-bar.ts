import { OPTIONS_TOOL } from "./data/filters";
import type { Filter, Found } from "./data/values";

// Filters as openui-lang. Which filters there are, and the periods the date filter offers, come
// from the database (data/values.ts). A filter's options are not written in either: the dashboard
// loads them from the data each time it opens. The plan for a dashboard (brief.ts) and the
// examples are both written with these.

const option = (value: string, label: string) =>
  `{value: ${JSON.stringify(value)}, label: ${JSON.stringify(label)}}`;

/** The date filter, with the periods the data is long enough for, as the tools read `range`. */
export const dateFilter = (ranges: Found["ranges"]) =>
  `DateRangeFilter($range, [${ranges.map((range) => option(range.value, range.label)).join(", ")}], "Date range")`;

/** The name a dashboard gives the Query that loads its filters' options. */
export const OPTIONS = "filterOptions";

/** That Query, for the filters a dashboard has. Until it answers, each shows its all option alone. */
export const optionsQuery = (filters: readonly Pick<Filter, "name" | "all">[]) =>
  `${OPTIONS} = Query(${JSON.stringify(OPTIONS_TOOL)}, {}, {${filters.map(({ name, all }) => `${name}: [${option("", all)}]`).join(", ")}})`;

/** A filter over one dimension, its options loaded by `optionsQuery`: a dropdown, or chips. */
export const dimensionFilter = (
  { name, label }: Pick<Filter, "name" | "label">,
  kind: "SelectFilter" | "ChipFilter" = "SelectFilter",
) => `${kind}($${name}, ${OPTIONS}.${name}, ${JSON.stringify(label)})`;

/** The arguments that make a Query follow the filters: `range: $range, region: $region`. */
export const filterArgs = (names: readonly string[]) =>
  ["range: $range", ...names.map((name) => `${name}: $${name}`)].join(", ");
