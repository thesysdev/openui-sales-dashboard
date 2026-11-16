// What a dashboard can filter by: the four dimensions every data tool narrows to, and the date
// presets. One list, read by the data tools (their argument schemas) and by the examples the
// builder learns from, so a filter never offers a value the tools don't know. The values are
// spelled as the tools' rows show them ("Apparel", "Paid search"), so a dashboard can match a
// filter's value against a row's name; the tools read them in any case.

export const FILTERS = {
  region: {
    label: "Region",
    all: "All regions",
    values: ["West", "South", "Midwest", "Northeast"],
  },
  category: {
    label: "Category",
    all: "All categories",
    values: ["Apparel", "Footwear", "Accessories"],
  },
  brand: {
    label: "Brand",
    all: "All brands",
    values: [
      "Northstar",
      "Northstar Footwear",
      "Northstar Studio",
      "N. Active",
      "North & Co.",
      "Weekend Supply",
    ],
  },
  channel: {
    label: "Channel",
    all: "All channels",
    values: [
      "Direct",
      "Email",
      "Organic search",
      "Paid search",
      "Paid social",
      "Referral",
      "Affiliate",
    ],
  },
} as const;

export type FilterName = keyof typeof FILTERS;
export const FILTER_NAMES = Object.keys(FILTERS) as [FilterName, ...FilterName[]];

/** The date filter's presets: its value (what the tools read as `range`) and its label. */
export const RANGES = [
  { value: "1m", label: "Last month" },
  { value: "3m", label: "Last 3 months" },
  { value: "12m", label: "Last 12 months" },
  { value: "lifetime", label: "Lifetime" },
] as const;

export type RangeValue = (typeof RANGES)[number]["value"];
/** The range a dashboard opens on when the request names none. */
export const DEFAULT_RANGE: RangeValue = "3m";
export const RANGE_VALUES = RANGES.map((range) => range.value) as [RangeValue, ...RangeValue[]];

/** "organic_search" → "Organic search", for a filter option's label. */
export const optionLabel = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
