import {
  DIMENSIONS,
  ORDERS_JOIN,
  PRODUCTS_JOIN,
  SALES_WHERE,
  dataDays,
  query,
  type Dimension,
} from "./db";
import { cached } from "./fetch";
import { optionLabel } from "./filters";

// What a dashboard can be narrowed by, found in the database and not written here: which
// columns are filters, the values each holds, and the periods the data is long enough for. A
// column that appears in the data becomes a filter, and a new brand or channel one of its
// options, with no change to the code. Looked up again every 10 minutes.

const TTL = 10 * 60_000;
/** A column with one value narrows nothing, and one with more than this is not picked from. */
const FEWEST = 2;
const MOST = 50;
/** Columns that identify or describe a row, which nobody filters a dashboard by. */
const NOT_A_FILTER =
  /(^|_)(id|name|title|email|phone|address|street|zip|postal_code|description|notes?|url|sku|code)$/i;

/** A filter the data has. */
export type Filter = {
  /** The argument the tools take it as, and the dashboard's variable: "region". */
  name: string;
  /** "Region", and the option that means no filter: "All regions". */
  label: string;
  all: string;
  /** The column it narrows, and whether reading it needs the products join. */
  sql: string;
  products: boolean;
  /** Where that column is, as the database names it: "orders.shipping_region". */
  column: string;
  /** Its values, most orders first: as a reader sees them, and as the column holds them. */
  values: string[];
  raw: string[];
};

export type Found = {
  filters: Filter[];
  /** The periods the date filter offers, and the one a dashboard opens on by default. */
  ranges: { value: string; label: string }[];
  opens: string;
  /** The first day with orders, "2024-11-03". */
  first: string;
};

/** The tables a join reads, by the alias each goes under: {o: "orders", p: "products"}. */
const tables = (join: string): Record<string, string> =>
  Object.fromEntries(
    [...join.matchAll(/retail\.(\w+)\s+(\w+)/g)].map(([, table, alias]) => [alias, table]),
  );
const ALWAYS = tables(ORDERS_JOIN);
const WITH_PRODUCTS = tables(PRODUCTS_JOIN);

/** The names the tools already split by, for the columns they read: {"o.shipping_region": "region"}. */
const KNOWN: Record<string, Dimension> = Object.fromEntries(
  (Object.keys(DIMENSIONS) as Dimension[]).flatMap((name) => {
    const column = DIMENSIONS[name].sql.match(/\b\w+\.\w+\b/)?.[0];
    return column ? [[column, name]] : [];
  }),
);

/** "Category" → "All categories", "Device" → "All devices". */
const allOf = (label: string) =>
  `All ${label.toLowerCase().replace(/y$/, "ie").replace(/s$/, "se")}s`;

/** What the data can be narrowed by now. */
export const found = (): Promise<Found> =>
  cached("db:found", TTL, async () => {
    // Shared by every request in those minutes, so it isn't tied to the one that loads it.
    const signal = new AbortController().signal;
    const aliases = { ...ALWAYS, ...WITH_PRODUCTS };
    const joined = Object.values(aliases);
    const columns = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'retail'
          AND table_name IN (${joined.map((_, at) => `$${at + 1}`).join(", ")})
          AND data_type IN ('text', 'character varying', 'USER-DEFINED')
        ORDER BY table_name, ordinal_position`,
      joined,
      signal,
    );
    // The orders' own columns first, then each joined table's, in the order they are joined.
    columns.sort((a, b) => joined.indexOf(a.table_name) - joined.indexOf(b.table_name));
    const filters = await Promise.all(
      columns
        .filter(({ column_name }) => !NOT_A_FILTER.test(column_name))
        .map(async ({ table_name, column_name }): Promise<Filter | null> => {
          const alias = Object.keys(aliases).find((key) => aliases[key] === table_name)!;
          const column = `${alias}.${column_name}`;
          const known = KNOWN[column];
          const name = known ?? column_name;
          const sql = known ? DIMENSIONS[known].sql : column;
          const products = alias in WITH_PRODUCTS;
          // The values among the orders dashboards count, one more than a filter may have.
          const rows = await query<{ value: string | null }>(
            `SELECT ${sql}::text AS value
               FROM ${ORDERS_JOIN}${products ? PRODUCTS_JOIN : ""}
              WHERE ${SALES_WHERE}
              GROUP BY 1
              ORDER BY count(*) DESC
              LIMIT ${MOST + 1}`,
            [],
            signal,
          );
          const raw = rows.flatMap(({ value }) => (value?.trim() ? [value.trim()] : []));
          if (raw.length < FEWEST || raw.length > MOST) return null;
          const label = optionLabel(name);
          return {
            name,
            label,
            all: allOf(label),
            sql,
            products,
            column: `${table_name}.${column_name}`,
            values: raw.map(optionLabel),
            raw,
          };
        }),
    );

    // A period is offered when the data reaches further back than it.
    const { first, last } = await dataDays();
    const months = (Date.parse(last) - Date.parse(first)) / (30.44 * 86_400_000);
    const ranges = [1, 3, 6, 12, 24]
      .filter((length) => length < months)
      .map((length) => ({
        value: `${length}m`,
        label: length === 1 ? "Last month" : `Last ${length} months`,
      }));
    ranges.push({ value: "lifetime", label: "Lifetime" });
    latest = {
      filters: filters
        .flatMap((filter) => (filter ? [filter] : []))
        // One filter per name.
        .filter((filter, at, list) => list.findIndex((other) => other.name === filter.name) === at),
      ranges,
      opens: ranges.some(({ value }) => value === "3m") ? "3m" : ranges[0]!.value,
      first,
    };
    return latest;
  });

let latest: Found | undefined;
/**
 * The filters found last, without waiting for the database: for what is read while a tool's
 * arguments are described. None before the first look.
 */
export const foundFilters = (): Filter[] => latest?.filters ?? [];

/** The month the data starts in: "November 2024". */
export const firstMonth = ({ first }: Found) =>
  new Date(`${first}T00:00:00Z`).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** One of the data's filters by name. */
export const filterNamed = (data: Found, name: string) =>
  data.filters.find((filter) => filter.name === name);

export type FilterOption = { value: string; label: string };

/** Each filter's options as a dashboard shows them: all first, then the values. */
export async function filterOptions(): Promise<Record<string, FilterOption[]>> {
  const { filters } = await found();
  return Object.fromEntries(
    filters.map(({ name, all, values }) => [
      name,
      [{ value: "", label: all }, ...values.map((value) => ({ value, label: value }))],
    ]),
  );
}
