import { dateFilter, dimensionFilter, filterArgs, optionsQuery } from "./filter-bar";

// Examples for the builder, written with this app's own data tools in place of the dashboard
// library's generic ones (which query SQL by hand and write numbers in). They are short on
// purpose: each shows how this data is wired (filters passed into every Query that can follow
// them, a filter's options loaded from the data, previous values, a series per group, a card's
// own switch) and not what a dashboard should look like. Neither answers a request the home page
// can make, so there is no dashboard to copy.

// What the examples are written with. A real dashboard's filters and periods come from the
// database (data/values.ts); these only show the shape.
const DATES = dateFilter([
  { value: "1m", label: "Last month" },
  { value: "3m", label: "Last 3 months" },
  { value: "12m", label: "Last 12 months" },
  { value: "lifetime", label: "Lifetime" },
]);
const REGION = { name: "region", label: "Region", all: "All regions" };
const CATEGORY = { name: "category", label: "Category", all: "All categories" };

/** Filters into Queries, headline numbers with what came before, one series per group. */
const SALES_OVER_TIME = `root = Dashboard([filters, lead, trend])
$range = "3m"
$region = ""
${optionsQuery([REGION])}
overview = Query("get_sales_overview", {${filterArgs(["region"])}}, {net_sales: 0, orders: 0, aov: 0, previous: {net_sales: null, orders: null, aov: null}})
overTime = Query("get_sales_trend", {group_by: "category", ${filterArgs(["region"])}}, {periods: [], series: []})
filters = FilterBar([${DATES}, ${dimensionFilter(REGION)}])
lead = Section("", [Kpis([Kpi("Net sales", overview.net_sales, "currency-compact", overview.previous.net_sales), Kpi("Orders", overview.orders, "number", overview.previous.orders), Kpi("Average order value", overview.aov, "currency-precise", overview.previous.aov)])])
trend = Section("Over time", [Row([Card("Net sales by category", [TimeSeries(overTime.periods, @Each(overTime.series, "s", Series(s.name, s.net_sales)), "area", "currency-compact", true)], "full", "USD")])])`;

/** A short list as chips, rows read by a chart and a table, and a card that switches its own split. */
const WHERE_SALES_COME_FROM = `root = Dashboard([filters, mix])
$range = "12m"
$category = ""
$by = "brand"
${optionsQuery([CATEGORY])}
byChannel = Query("get_sales_breakdown", {dimension: "channel", ${filterArgs(["category"])}}, {rows: []})
split = Query("get_sales_breakdown", {dimension: $by, ${filterArgs(["category"])}}, {rows: []})
filters = FilterBar([${DATES}, ${dimensionFilter(CATEGORY, "ChipFilter")}])
mix = Section("Where sales come from", [Row([Card("Share by channel", [Donut(byChannel.rows.name, byChannel.rows.net_sales, "currency-compact", "Net sales")], "third"), Card("Net sales, orders and returns", [Table([Column("Name", split.rows.name, "primary"), Column("Net sales", split.rows.net_sales, "bar", "currency-compact"), Column("Orders", split.rows.orders, "number", "number"), Column("Average order", split.rows.aov, "number", "currency-precise"), Column("Return rate", split.rows.return_rate_pct, "number", "percent")])], "two-thirds", "Split by the dimension chosen", [ChipFilter($by, [{value: "brand", label: "Brand"}, {value: "region", label: "Region"}, {value: "device", label: "Device"}])])])])`;

export const examples: string[] = [SALES_OVER_TIME, WHERE_SALES_COME_FROM];
