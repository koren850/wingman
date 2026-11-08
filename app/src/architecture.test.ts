// Keeps the layers of app/src clean. It reads the import statements of every source file (TypeScript compiler API, no new dependency) and checks:
//   1. no import cycles between source files (a cycle makes load order matter and makes files impossible to read on their own);
//   2. the libraries (lang, providers, context, moments, session) never import the call engine, the CLI or an entry point;
//   3. the engine never imports the CLI, and nothing imports an entry point (run.ts, call.ts, ...).
// Type-only imports are ignored: they are erased and cannot make a runtime cycle. Test files, e2e and testkit are not part of the layers.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = path.dirname(fileURLToPath(import.meta.url));
/** Files that start a process. Nothing may import them: they run code at load time. */
const ENTRY_POINTS = new Set(["run.ts", "call.ts", "gate.ts", "doctor.ts", "synth.ts", "settings-cli.ts", "keys-cli.ts", "cli/index.ts"]);
/** Library folders: they know nothing about a running call. */
const LIBRARIES = ["lang", "providers", "context", "moments", "session"];

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["e2e", "testkit", "fixtures"].includes(e.name)) continue;
      sourceFiles(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.startsWith("test-")) out.push(p);
  }
  return out;
}

/** The runtime imports of one file as { from, to } pairs between source files (relative paths from src/). */
function buildGraph(): Map<string, Set<string>> {
  const files = sourceFiles();
  const known = new Set(files.map(rel));
  const graph = new Map<string, Set<string>>();
  for (const f of files) {
    const deps = new Set<string>();
    const add = (spec: string) => {
      if (!spec.startsWith(".")) return;
      const target = rel(path.resolve(path.dirname(f), spec));
      for (const c of [target, target.replace(/\.(js|ts)$/, "") + ".ts", target + "/index.ts"]) if (known.has(c)) return void deps.add(c);
    };
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const c = n.importClause;
        const typeOnly =
          c && (c.isTypeOnly || (!c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.every((e) => e.isTypeOnly)));
        if (!typeOnly) add(n.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && !n.isTypeOnly) add(n.moduleSpecifier.text);
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0]))
        add(n.arguments[0].text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    graph.set(rel(f), deps);
  }
  return graph;
}

/** Strongly connected groups of more than one file (Tarjan). Each one is an import cycle. */
function cycles(graph: Map<string, Set<string>>): string[][] {
  let n = 0;
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    onStack = new Set<string>(),
    out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, n);
    low.set(v, n++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) out.push(group.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return out;
}

const folder = (f: string) => (f.includes("/") ? f.split("/")[0]! : "");
const edges = (graph: Map<string, Set<string>>) => [...graph].flatMap(([from, to]) => [...to].map((t) => ({ from, to: t })));

test("architecture: the graph reads the source files (the checks below are not empty)", () => {
  const g = buildGraph();
  assert.ok(g.size > 150, `only ${g.size} files found`);
  assert.ok(edges(g).length > 500);
  assert.ok(g.get("run.ts")!.has("engine/state.ts"));
  // The cycle finder finds a cycle when there is one.
  assert.equal(
    cycles(
      new Map([
        ["a.ts", new Set(["b.ts"])],
        ["b.ts", new Set(["a.ts"])],
      ]),
    ).length,
    1,
  );
});

test("architecture: no import cycles between source files", () => {
  const found = cycles(buildGraph());
  assert.deepEqual(
    found,
    [],
    `import cycles:\n${found.map((c) => "  " + c.join(" <-> ")).join("\n")}\nPass the function in as an argument or through engine/lifecycle.ts instead of importing it back.`,
  );
});

test("architecture: libraries (lang, providers, context, moments, session) do not import the engine, the CLI or an entry point", () => {
  const bad = edges(buildGraph()).filter(
    (e) => LIBRARIES.includes(folder(e.from)) && (folder(e.to) === "engine" || folder(e.to) === "cli" || ENTRY_POINTS.has(e.to)),
  );
  assert.deepEqual(
    bad.map((e) => `${e.from} -> ${e.to}`),
    [],
  );
});

test("architecture: the engine does not import the CLI, and nothing imports an entry point", () => {
  const g = edges(buildGraph());
  assert.deepEqual(
    g.filter((e) => folder(e.from) === "engine" && folder(e.to) === "cli").map((e) => `${e.from} -> ${e.to}`),
    [],
  );
  assert.deepEqual(
    g.filter((e) => ENTRY_POINTS.has(e.to)).map((e) => `${e.from} -> ${e.to}`),
    [],
  );
});

test("architecture: the context builders do not import the engine or the CLI", () => {
  const bad = edges(buildGraph()).filter((e) => folder(e.from) === "context" && ["engine", "cli"].includes(folder(e.to)));
  assert.deepEqual(bad, []);
});

test("architecture: run.ts loads shutdown.ts, which fills the lifecycle hooks (otherwise a stop request would do nothing)", async () => {
  assert.ok(buildGraph().get("run.ts")!.has("engine/shutdown.ts"));
  const { lifecycle } = await import("./engine/lifecycle.ts");
  const before = lifecycle.shutdown;
  await import("./engine/shutdown.ts");
  assert.notEqual(lifecycle.shutdown, before);
  assert.equal(typeof lifecycle.skipSummaryNow, "function");
});
