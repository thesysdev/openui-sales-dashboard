import { dateFilter, dimensionFilter, filterArgs } from "./filter-bar";

// Examples for the builder, written with this app's own data tools in place of the dashboard
// library's generic ones (which query SQL by hand and write numbers in). They are short on
// purpose: each shows how this data is wired (filters passed into every Query that can follow
// them, previous values, a series per group, a card's own switch, a month-by-scope grid) and not
// what a dashboard should look like. Each has a different shape, different filters and different
// charts, so no layout is the one to copy: what a dashboard shows is the builder's choice.

/** Filters into Queries, headline numbers with what came before, one series per group. */
const SALES_OVER_TIME = `root = Dashboard([filters, lead, trend])
$range = "3m"
$region = ""
overview = Query("get_sales_overview", {${filterArgs(["region"])}}, {net_sales: 0, orders: 0, aov: 0, previous: {net_sales: null, orders: null, aov: null}})
overTime = Query("get_sales_trend", {group_by: "category", ${filterArgs(["region"])}}, {periods: [], series: []})
filters = FilterBar([${dateFilter}, ${dimensionFilter("region")}, CompareToggle("Previous period", true)])
lead = Section("", [Kpis([Kpi("Net sales", overview.net_sales, "currency-compact", overview.previous.net_sales), Kpi("Orders", overview.orders, "number", overview.previous.orders), Kpi("Average order value", overview.aov, "currency-precise", overview.previous.aov)])])
trend = Section("Over time", [Row([Card("Net sales by category", [TimeSeries(overTime.periods, @Each(overTime.series, "s", Series(s.name, s.net_sales)), "area", "currency-compact", true)], "full", "USD")])])`;

/** A short list as chips, rows read by a chart and a table, and a card that switches its own split. */
const WHERE_SALES_COME_FROM = `root = Dashboard([filters, mix])
$range = "12m"
$category = ""
$by = "brand"
byChannel = Query("get_sales_breakdown", {dimension: "channel", ${filterArgs(["category"])}}, {rows: []})
split = Query("get_sales_breakdown", {dimension: $by, ${filterArgs(["category"])}}, {rows: []})
filters = FilterBar([${dateFilter}, ${dimensionFilter("category", "ChipFilter")}])
mix = Section("Where sales come from", [Row([Card("Share by channel", [Donut(byChannel.rows.name, byChannel.rows.net_sales, "currency-compact", "Net sales")], "third"), Card("Net sales, orders and returns", [Table([Column("Name", split.rows.name, "primary"), Column("Net sales", split.rows.net_sales, "bar", "currency-compact"), Column("Orders", split.rows.orders, "number", "number"), Column("Average order", split.rows.aov, "number", "currency-precise"), Column("Return rate", split.rows.return_rate_pct, "number", "percent")])], "two-thirds", "Split by the dimension chosen", [ChipFilter($by, [{value: "brand", label: "Brand"}, {value: "region", label: "Region"}, {value: "device", label: "Device"}])])])])`;

/** One Query read three ways: its total, each scope, and a month-by-scope grid. */
const TARGETS_BY_REGION = `root = Dashboard([filters, lead, regions, months])
$range = "12m"
$region = ""
targets = Query("get_targets_vs_actuals", {scope: "region", ${filterArgs(["region"])}}, {total: {target: 0, actual: 0, gap: 0, attainment_pct: 0}, totals: [], over_time: [], rows: []})
filters = FilterBar([${dateFilter}, ${dimensionFilter("region")}])
lead = Section("", [Kpis([Kpi("Net sales", targets.total.actual, "currency-compact", null, null, "After refunds"), Kpi("Target", targets.total.target, "currency-compact"), Kpi("Attainment", targets.total.attainment_pct, "percent"), Kpi("Gap to target", targets.total.gap, "currency-compact")])])
regions = Section("Regions", [Row([Card("Attainment by region", [Bars(targets.totals.scope, [Series("Attainment", targets.totals.attainment_pct)], "percent", "horizontal", false, "up", [Reference("Target", 100)])], "half", "Net sales as a share of target"), Card("Gap to target", [Table([Column("Region", targets.totals.scope, "primary"), Column("Target", targets.totals.target, "number", "currency-compact"), Column("Net sales", targets.totals.actual, "number", "currency-compact"), Column("Gap", targets.totals.gap, "delta", "currency-compact", null, "up")])], "half", "USD")])])
months = Section("Month by month", [Row([Card("Attainment by region and month", [Heatmap(targets.rows.scope, targets.rows.month, targets.rows.attainment_pct, "percent", true, 100)], "full", "Net sales as a share of target")])])`;

export const examples: string[] = [SALES_OVER_TIME, WHERE_SALES_COME_FROM, TARGETS_BY_REGION];
