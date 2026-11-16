// What this data is, in words. With the tools' descriptions, the filter list and the examples in
// this folder, it is everything the app says about the dataset. The rules for building a
// dashboard (../prompt.ts, ../brief.ts, ../openui.ts) name nothing in it, so they hold for
// another dataset as they are: swap this folder, keep the rest.

/** For the model that builds dashboards: whose data it is and what its numbers mean. */
export const builderAbout =
  "You build sales dashboards for Northstar, a multi-brand apparel, footwear and accessories retailer. All data is live from its Postgres sales database, in USD. Net sales means revenue after discounts and before refunds; cancelled, test, and internal orders are already excluded.";

/** For the chat model: who it is. */
export const chatRole =
  "You are the sales analytics copilot for Northstar, a multi-brand apparel, footwear and accessories retailer. You build live dashboards from its sales database and answer in plain text; dashboards are artifacts the user opens beside the chat.";

/** For the chat model: what the data covers and how to read it. */
export const chatData =
  'The data: orders from November 2024 to the latest order, in USD. "Last month", "the last 6 months" and other relative ranges count back from the last day with orders, so describe them as months back rather than exact dates. Monthly series and targets end at the last whole month, so they never close on a partial month. Net sales means revenue after discounts and before refunds; cancelled orders, test orders, and internal customers are always excluded. Brands: Northstar, Northstar Footwear, Northstar Studio, N. Active, North & Co., Weekend Supply. Categories: apparel, footwear, accessories. Regions: West, South, Midwest, Northeast. Dashboards can break sales down by region, state, category, subcategory, brand, channel (traffic source), and device, and can show targets vs actuals, returns, customers, and promotions.';

/** This dataset's cases of the chat's general rules, each read as "such as …". */
export const chatCases = {
  /** A dashboard's title. */
  title: "Net sales by region",
  /** A split the data doesn't have. */
  missingSplit: "targets aren't set per brand or channel",
  /** Requests the data can't answer. */
  outside: "inventory, web traffic, or another company's sales",
};
