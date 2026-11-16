import { parseExpression, parseMessage, split, tokenize, type ASTNode } from "@openuidev/lang-core";
import { dataTools } from "./data";
import { FILTERS } from "./data/filters";

// Checks that a dashboard's controls work: every filter in its FilterBar changes every card that
// can follow it, and no filter or card switch is left changing nothing. It reads the program the
// builder wrote, with the parser the renderer uses, and knows the data only by its tools'
// argument names and its filter list, so it holds for any dataset in ./data.

/**
 * A tool can take an argument that some of its calls don't follow. Its dataset says so on the
 * tool, beside its parameters: the argument, then the other argument and the values of it that
 * switch the first off. `{ a: { mode: ["x"] } }` reads "a call with mode x doesn't follow a".
 */
export type Ignores = Record<string, Record<string, readonly string[]>>;

/** What the check knows of the data: each tool's arguments, and each filter's label for all. */
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

export type Problem = {
  /**
   * unpassed: a Query leaves out a filter its tool takes. fixed: a Query writes its own value
   * for an argument a filter sets. unread: nothing shown reads a control's variable. unbound: a
   * control has no variable. unsaid: a card can't follow a filter and doesn't say so.
   */
  kind: "unpassed" | "fixed" | "unread" | "unbound" | "unsaid";
  /** What to change, as one sentence the builder can act on. */
  fix: string;
};

/** The edit that repairs a dashboard: one line per problem, and nothing else changes. */
export const repairPrompt = (problems: readonly Problem[]) =>
  [
    "Repair this dashboard's filters. Make exactly these changes and keep everything else as it is:",
    ...problems.map((problem) => `- ${problem.fix}`),
  ].join("\n");

// Where the library's components hold what the check reads.
const BAR = "FilterBar";
const CARD = "Card";
const QUERY = "Query";
/** Card(title, content, width, subtitle, controls). */
const CARD_CONTENT = 1;
const CARD_SUBTITLE = 3;
const CARD_CONTROLS = 4;
/** The one control that works without a variable. */
const NEEDS_NO_VARIABLE = "CompareToggle";
/** The controls that set a date. */
const DATES = ["DateRangeFilter", "PeriodPicker"];

type Comp = Extract<ASTNode, { k: "Comp" }>;
type Control = { name: string; variable: string | null };
type Reads = { variables: Set<string>; queries: Set<string> };

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
      // A statement that doesn't parse draws nothing, so there is nothing in it to check.
    }
  }
  return found;
}

/**
 * A dashboard's program as written: its statements, each Query's tool and arguments, the
 * FilterBar that is shown and the Cards that are drawn. The check and the plan for an edit both
 * read a dashboard through this.
 */
function parse(program: string) {
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

  /** The controls in a FilterBar's or a Card's list, each with the variable it sets. */
  const controls = (list: ASTNode | undefined): Control[] => {
    const items = resolve(list);
    return (items?.k === "Arr" ? items.els : []).flatMap((item) => {
      const control = resolve(item);
      if (control?.k !== "Comp") return [];
      const first = control.args[0];
      // CompareToggle takes its variable later, and only with options.
      const bound =
        control.name === NEEDS_NO_VARIABLE
          ? control.args.find((arg) => arg.k === "StateRef")
          : first?.k === "StateRef"
            ? first
            : undefined;
      return [{ name: control.name, variable: bound?.k === "StateRef" ? bound.n : null }];
    });
  };

  /** The arguments a variable is passed as, in any Query. */
  const passedAs = (variable: string) => {
    const found = new Set<string>();
    for (const name of all.keys()) {
      for (const [argument, value] of call(name)?.args ?? []) {
        if (value.k === "StateRef" && value.n === variable) found.add(argument);
      }
    }
    return found;
  };

  // What is drawn: everything the root reaches. The first FilterBar is the one shown.
  const cards: Comp[] = [];
  let bar: Comp | undefined;
  const seen = new Set<string>();
  const find = (node: ASTNode | undefined) => {
    if (!node) return;
    if (node.k === "Ref") {
      if (!all.has(node.n) || seen.has(node.n)) return;
      seen.add(node.n);
      return find(all.get(node.n));
    }
    if (isComp(node, BAR)) bar ??= node;
    if (isComp(node, CARD)) cards.push(node);
    children(node).forEach(find);
  };
  const root: ASTNode = { k: "Ref", n: all.has("root") ? "root" : ([...all.keys()][0] ?? "") };
  find(root);
  return { all, resolve, call, controls, passedAs, cards, bar: bar as Comp | undefined, root };
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
  const { all, call, controls, passedAs, bar } = parse(program);
  const known = (argument: string) =>
    Object.values(data.tools).some((tool) => tool.takes.includes(argument));
  return {
    bar: controls(bar?.args[0]).flatMap(({ variable }) => {
      if (!variable) return [];
      const passed = [...passedAs(variable)];
      const named = variable.slice(1);
      // A filter is passed as the argument it narrows; unpassed, it is the one of its name.
      const argument =
        passed.find((name) => name in data.filters) ?? passed[0] ?? (known(named) ? named : "");
      return [{ variable, argument }];
    }),
    queries: [...all.keys()].flatMap((name) => {
      const query = call(name);
      return query ? [{ name, tool: query.tool }] : [];
    }),
  };
}

/** The problems in a dashboard's program: none when every control changes what it sits over. */
export function checkProgram(program: string, data: Dataset = dataset): Problem[] {
  const { all, resolve, call, controls, passedAs, cards, bar, root } = parse(program);
  /** A data tool by its own name: a Query may name anything, a script included. */
  const toolOf = (name: string) => (Object.hasOwn(data.tools, name) ? data.tools[name] : undefined);

  /** Whether this call doesn't follow an argument its tool takes. */
  const ignores = (query: NonNullable<ReturnType<typeof call>>, argument: string) =>
    Object.entries(toolOf(query.tool)?.ignores?.[argument] ?? {}).some(([other, values]) => {
      const value = resolve(query.args.get(other));
      return value?.k === "Str" && values.includes(value.v);
    });

  // What a value changes with: the variables it reads and the Queries it reads, through the
  // statements it names. A Query changes with its arguments, less the ones its call ignores. A
  // control's own variable is not a read, so the lists that hold controls are passed over.
  const known = new Map<string, Reads>();
  const reads = (
    node: ASTNode | undefined,
    into: Reads = { variables: new Set(), queries: new Set() },
  ) => {
    if (!node) return into;
    if (node.k === "StateRef") into.variables.add(node.n);
    if (node.k === "Ref" && all.has(node.n)) {
      let named = known.get(node.n);
      if (!named) {
        named = { variables: new Set(), queries: new Set() };
        // Set before it is filled, so a statement that names itself ends here.
        known.set(node.n, named);
        const statement = all.get(node.n)!;
        const query = call(node.n);
        if (isComp(statement, QUERY)) named.queries.add(node.n);
        if (query) {
          // A Query changes with an argument only if its tool takes it and this call follows it.
          // A tool the data doesn't have (a script) is taken at its word.
          const takes = toolOf(query.tool)?.takes;
          for (const [argument, value] of query.args) {
            if (takes && !takes.includes(argument)) continue;
            if (!ignores(query, argument)) reads(value, named);
          }
        } else {
          reads(statement, named);
        }
      }
      named.variables.forEach((variable) => into.variables.add(variable));
      named.queries.forEach((query) => into.queries.add(query));
    }
    const skip = isComp(node, BAR) ? 0 : isComp(node, CARD) ? CARD_CONTROLS : -1;
    children(node).forEach((child, at) => at !== skip && reads(child, into));
    return into;
  };

  /** The words written in a value, such as a card's subtitle. */
  const words = (node: ASTNode | undefined): string => {
    const value = resolve(node);
    if (!value) return "";
    return value.k === "Str" ? value.v : children(value).map(words).join(" ");
  };

  const drawn = reads(root);
  const queries = [...drawn.queries].flatMap((name) => {
    const query = call(name);
    return query && toolOf(query.tool) ? [{ name, ...query }] : [];
  });

  const problems: Problem[] = [];
  const title = (card: Comp) => JSON.stringify(words(card.args[0]));

  // A control with no variable is connected to nothing.
  const unbound = (control: Control, where: string) =>
    control.variable === null &&
    control.name !== NEEDS_NO_VARIABLE &&
    problems.push({
      kind: "unbound",
      fix: `The ${control.name} in ${where} sets no $variable, so it changes nothing: remove it.`,
    });

  // A card's own switch changes that card.
  for (const card of cards) {
    const content = reads(card.args[CARD_CONTENT]);
    for (const control of controls(card.args[CARD_CONTROLS])) {
      unbound(control, `the card ${title(card)}`);
      if (control.variable && !content.variables.has(control.variable)) {
        problems.push({
          kind: "unread",
          fix: `The ${control.variable} switch on the card ${title(card)} changes nothing in it: pass ${control.variable} into the Query that card reads, or remove the switch and its declaration.`,
        });
      }
    }
  }

  for (const filter of controls(bar?.args[0])) {
    unbound(filter, `the ${BAR}`);
    const variable = filter.variable;
    if (!variable) continue;

    // The argument a filter sets is the one it is passed as; unpassed, the one of its name.
    const feeds = passedAs(variable);
    const named = variable.slice(1);
    if (!feeds.size && Object.values(data.tools).some((tool) => tool.takes.includes(named))) {
      feeds.add(named);
    }
    /** The argument through which this Query can follow the filter, if any. */
    const follows = (query: (typeof queries)[number]) =>
      toolOf(query.tool)!.takes.find(
        (argument) => feeds.has(argument) && !ignores(query, argument),
      );
    // A date or one of the data's filters narrows every card. Any other control in the bar is a
    // switch, which only has to change something.
    const narrows =
      DATES.includes(filter.name) || [...feeds, named].some((name) => name in data.filters);

    // Every Query whose tool takes the filter passes it, and none writes that argument itself.
    let found = false;
    for (const query of narrows ? queries : []) {
      const argument = follows(query);
      if (!argument || reads({ k: "Ref", n: query.name }).variables.has(variable)) continue;
      found = true;
      const own = query.args.get(argument);
      problems.push(
        own
          ? {
              kind: "fixed",
              fix: `Query ${query.name} sets ${argument} itself, so the ${variable} filter can't change it: pass ${argument}: ${variable} instead.`,
            }
          : {
              kind: "unpassed",
              fix: `Query ${query.name} leaves out the ${variable} filter: add ${argument}: ${variable} to its arguments.`,
            },
      );
    }
    if (!found && !drawn.variables.has(variable)) {
      problems.push({
        kind: "unread",
        fix: `Nothing reads the ${variable} filter: remove it from the ${BAR}, with its declaration.`,
      });
      continue;
    }

    // A card none of whose Queries can follow a filter says so, with the filter's label for all.
    const label = [...feeds, named].map((name) => data.filters[name]?.all).find(Boolean);
    if (!label) continue;
    for (const card of cards) {
      const content = reads(card.args[CARD_CONTENT]);
      if (!content.queries.size || content.variables.has(variable)) continue;
      const read = queries.filter((query) => content.queries.has(query.name));
      if (read.length < content.queries.size || read.some(follows)) continue;
      if (words(card.args[CARD_SUBTITLE]).toLowerCase().includes(label.toLowerCase())) continue;
      problems.push({
        kind: "unsaid",
        fix: `The card ${title(card)} can't follow the ${variable} filter: say ${JSON.stringify(label)} in its subtitle.`,
      });
    }
  }
  return problems;
}
