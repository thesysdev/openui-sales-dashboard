import { parseExpression, parseMessage, split, tokenize, type ASTNode } from "@openuidev/lang-core";
import { dataTools } from "./data";
import { FILTERS } from "./data/filters";

// Reads a dashboard's program, with the parser the renderer uses, for a change to it: which
// filters its FilterBar has and which tool each Query calls. It knows the data only by its tools'
// argument names and its filter list, so it holds for any dataset in ./data.

/**
 * A tool can take an argument that some of its calls don't follow. Its dataset says so on the
 * tool, beside its parameters: the argument, then the other argument and the values of it that
 * switch the first off. `{ a: { mode: ["x"] } }` reads "a call with mode x doesn't follow a".
 */
export type Ignores = Record<string, Record<string, readonly string[]>>;

/** What is known of the data: each tool's arguments, and each filter's label for all. */
export type Dataset = {
  tools: Record<string, { takes: readonly string[]; ignores?: Ignores }>;
  filters: Record<string, { all: string }>;
};

/** The dataset in ./data. */
export const dataset: Dataset = {
  tools: Object.fromEntries(
    Object.entries(dataTools).map(([name, tool]) => [
      name,
      {
        takes: Object.keys((tool.parameters as { properties?: object }).properties ?? {}),
        ignores: (tool as { ignores?: Ignores }).ignores,
      },
    ]),
  ),
  filters: FILTERS,
};

// Where the library's components hold what is read here.
const BAR = "FilterBar";
const QUERY = "Query";
/** The one control that takes its variable later, and only with options. */
const NEEDS_NO_VARIABLE = "CompareToggle";

type Comp = Extract<ASTNode, { k: "Comp" }>;

const isComp = (node: ASTNode | undefined, name: string): node is Comp =>
  node?.k === "Comp" && node.name === name;

function children(node: ASTNode): ASTNode[] {
  switch (node.k) {
    case "Comp":
      return node.args;
    case "Arr":
      return node.els;
    case "Obj":
      return node.entries.map(([, value]) => value);
    case "BinOp":
      return [node.left, node.right];
    case "UnaryOp":
      return [node.operand];
    case "Ternary":
      return [node.cond, node.then, node.else];
    case "Member":
      return [node.obj];
    case "Index":
      return [node.obj, node.index];
    case "Assign":
      return [node.value];
    default:
      return [];
  }
}

/** The program's statements by name. A name written twice keeps its last statement, as drawn. */
function statements(program: string): Map<string, ASTNode> {
  const found = new Map<string, ASTNode>();
  for (const statement of split(tokenize(parseMessage(program).content))) {
    try {
      found.set(statement.id, parseExpression(statement.tokens));
    } catch {
      // A statement that doesn't parse draws nothing, so there is nothing in it to read.
    }
  }
  return found;
}

/** What a change to a dashboard has to know of it. */
export type Current = {
  /**
   * The FilterBar's controls, in order: the variable each sets, and the argument Queries pass it
   * as ("" for a control no Query passes, such as a switch read on the page).
   */
  bar: { variable: string; argument: string }[];
  /** Each Query's name and the tool it calls. */
  queries: { name: string; tool: string }[];
};

/**
 * Reads a dashboard for a change to it. Nothing comes back for a program that isn't whole yet:
 * one still being written may not have reached its FilterBar.
 */
export function readDashboard(program: string, data: Dataset = dataset): Current | undefined {
  if (!parseMessage(program).end) return undefined;
  const all = statements(program);
  // Follows a name to the statement it stands for. Names that lead back to themselves end where
  // the circle closes.
  const resolve = (node: ASTNode | undefined, seen = new Set<string>()): ASTNode | undefined => {
    if (node?.k !== "Ref" || !all.has(node.n) || seen.has(node.n)) return node;
    return resolve(all.get(node.n), seen.add(node.n));
  };

  /** A Query's tool and arguments, when both are written out. */
  const call = (name: string) => {
    const query = all.get(name);
    if (!isComp(query, QUERY)) return null;
    const tool = resolve(query.args[0]);
    const args = resolve(query.args[1]);
    if (tool?.k !== "Str" || (args && args.k !== "Obj")) return null;
    return { tool: tool.v, args: new Map(args?.k === "Obj" ? args.entries : []) };
  };
  const queries = [...all.keys()].flatMap((name) => {
    const query = call(name);
    return query ? [{ name, ...query }] : [];
  });

  // The FilterBar that is shown: the first one the root reaches.
  let bar: Comp | undefined;
  const seen = new Set<string>();
  const find = (node: ASTNode | undefined) => {
    if (!node || bar) return;
    if (node.k === "Ref") {
      if (!all.has(node.n) || seen.has(node.n)) return;
      seen.add(node.n);
      return find(all.get(node.n));
    }
    if (isComp(node, BAR)) bar = node;
    else children(node).forEach(find);
  };
  find({ k: "Ref", n: all.has("root") ? "root" : ([...all.keys()][0] ?? "") });

  /** The variables the bar's controls set, in order. */
  const items = resolve((bar as Comp | undefined)?.args[0]);
  const variables = (items?.k === "Arr" ? items.els : []).flatMap((item) => {
    const control = resolve(item);
    if (control?.k !== "Comp") return [];
    const bound =
      control.name === NEEDS_NO_VARIABLE
        ? control.args.find((arg) => arg.k === "StateRef")
        : control.args[0];
    return bound?.k === "StateRef" ? [bound.n] : [];
  });

  const known = (argument: string) =>
    Object.values(data.tools).some((tool) => tool.takes.includes(argument));
  return {
    bar: variables.map((variable) => {
      const passed = queries.flatMap((query) =>
        [...query.args].flatMap(([argument, value]) =>
          value.k === "StateRef" && value.n === variable ? [argument] : [],
        ),
      );
      const named = variable.slice(1);
      // A filter is passed as the argument it narrows; unpassed, it is the one of its name.
      const argument =
        passed.find((name) => name in data.filters) ?? passed[0] ?? (known(named) ? named : "");
      return { variable, argument };
    }),
    queries: queries.map(({ name, tool }) => ({ name, tool })),
  };
}
