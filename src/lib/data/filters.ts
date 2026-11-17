// What a dashboard can filter by is not written here: which filters there are, their values and
// the periods the date filter offers are all found in the database (values.ts). This holds only
// what they share.

/** The data tool a dashboard loads its filters' options from. */
export const OPTIONS_TOOL = "get_filter_options";

/** "organic_search" → "Organic search", for a filter's label and its options. */
export const optionLabel = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
