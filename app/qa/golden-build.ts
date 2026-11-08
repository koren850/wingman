// Builds the golden meeting JSON files from the hand-written sources in data/meetings/src/*.txt:  tsx qa/golden-build.ts
// Why a source format: a meeting is 40 to 60 lines of dialogue plus labels, and the labels sit best on the line they belong to.
// The builder adds line ids, times, moment ids, silent windows, the scripted model replies and test.lock.
//
// Source format (data/meetings/src/<id>.txt):
//   header:   key: value          id, split, lang, type, variant, user (Name | alias, alias), context (repeatable, joined),
//                                 roster (Name | me or them | role), agenda, brief (a fact from the pre-meeting text), likely (a likely question)
//   ---
//   body:     me: text   |   them@Speaker: text   |   .. 25 (a pause of 25 s)   |   // comment
//   labels after the text, each introduced by " ## ":
//     m: kind || token;token || tag,tag || SAY || WHY     a moment: a card of this kind is expected after this line
//          kinds answer prompt check fact; tags: direct (a question to the user), implied, objection, number-conflict, promise, jargon,
//          topic-shift, unanswered, latest=ms, v=0..3, aim=me|all
//          tag noq: the line (and the line before it) has no "?" and no question word; the builder refuses the file when it has
//     x: kind || tokens || SAY || latest=ms                an allowed extra: a useful card that is not a labelled moment (leaves precision alone)
//     quiet                                                this line is inside a silent window (a card here is a failure)
//     mem: n:what=value / c:who>what>due / f:text / q:asker>text / o:who>text / d:text / topic:text   a scripted memory patch after this line
//     chk: token;token                                     a memory check: the memory at this line must hold these tokens
//     ask: question || reply                               a scripted "ask the call" at this line
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lockHash } from "./golden-load.ts";
import { GoldenSchema, HELD_OUT, SPLITS, type Golden, type Kind } from "./golden-schema.ts";
import { noqProblems } from "./golden-noq.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MEETINGS = join(HERE, "..", "data", "meetings");
const TAG: Record<Kind, string> = { answer: "ANS", prompt: "PROMPT", check: "CHECK", fact: "TERM" };

const wordsOf = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const splitFields = (s: string) => s.split("||").map((x) => x.trim());

export function parseMeeting(src: string, file: string): Golden {
  const fail = (m: string, n?: number): never => {
    throw new Error(`${file}${n ? `:${n}` : ""}: ${m}`);
  };
  const [head, ...rest] = src.split(/^---\s*$/m);
  if (!rest.length) fail("missing --- between header and body");
  const hdr: Record<string, string[]> = {};
  for (const l of head.split("\n")) {
    if (!l.trim() || l.startsWith("//")) continue;
    const m = /^([a-z]+):\s*(.*)$/.exec(l);
    if (!m) fail(`bad header line: ${l}`);
    (hdr[m![1]] ??= []).push(m![2].trim());
  }
  const one = (k: string) => hdr[k]?.[0] ?? fail(`header ${k} missing`);
  const lang = one("lang") as Golden["lang"];
  const lines: Golden["lines"] = [];
  const moments: Golden["moments"] = [];
  const extras: NonNullable<Golden["allowedExtra"]> = [];
  const script: NonNullable<Golden["script"]> = [];
  const checks: NonNullable<Golden["memoryChecks"]> = [];
  const quiet: number[] = [];
  const problems: string[] = [];
  let t = 1500,
    lineNo = 0;
  const body = rest.join("---").split("\n");
  for (const raw of body) {
    lineNo++;
    const l = raw.trim();
    if (!l || l.startsWith("//")) continue;
    const pause = /^\.\.\s*(\d+)$/.exec(l);
    if (pause) {
      t += Number(pause[1]) * 1000;
      continue;
    }
    const lm = /^(me|them)(?:@([^:]+))?:\s*(.*)$/.exec(l);
    if (!lm) fail(`bad line: ${l}`, lineNo);
    const [text, ...anns] = lm![3].split(/\s+##\s+/);
    const id = `l${lines.length + 1}`;
    const sp = lm![2]?.trim();
    const dur = wordsOf(text).length * (/[\u0590-\u05ff]/.test(text) ? 420 : 380);
    t += dur; // t of a line is the moment its final transcript arrives (the end of the speech)
    lines.push({ id, t, side: lm![1] as "me" | "them", ...(sp ? { speaker: sp } : {}), text: text.trim() });
    t += 700 + ((lines.length * 7919) % 1500);
    for (const a of anns) {
      const am = /^(\w+)(?::\s*(.*))?$/s.exec(a.trim());
      if (!am) fail(`bad label: ${a}`, lineNo);
      const kw = am![1],
        arg = am![2] ?? "";
      if (kw.trim() === "quiet") {
        quiet.push(lines.length - 1);
        script.push({ role: "moment", whenLastLine: id, reply: "TAG: SKIP" });
      } else if (kw === "m") {
        const [kind, tok, tagS, say, why] = splitFields(arg);
        if (!["answer", "prompt", "check", "fact"].includes(kind)) fail(`bad moment kind ${kind}`, lineNo);
        const tags = tagS
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        const flag = (k: string) => tags.find((x) => x.startsWith(k + "="))?.slice(k.length + 1);
        const direct = tags.includes("direct");
        const mustMention = tok
          ? tok
              .split(";")
              .map((x) => x.trim())
              .filter(Boolean)
          : [];
        const latestMs = Number(flag("latest") ?? (direct ? 4000 : 8000));
        const value = Number(flag("v") ?? (direct ? 3 : 2));
        if (wordsOf(say).length > 14) problems.push(`${file}:${lineNo}: SAY over 14 words: ${say}`);
        const sq = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
        for (const k of mustMention) if (!sq(say).includes(sq(k))) problems.push(`${file}:${lineNo}: SAY lacks token "${k}": ${say}`);
        moments.push({
          id: `m${moments.length + 1}`,
          afterLine: id,
          kind: kind as Kind,
          ...(mustMention.length ? { mustMention } : {}),
          latestMs,
          ...(direct ? { direct: true } : {}),
          tags: tags.filter((x) => !x.includes("=") && x !== "direct"),
        });
        const aim = flag("aim") ?? "me";
        script.push({
          role: "moment",
          whenLastLine: id,
          ms: direct ? 900 : 1500,
          reply: `TAG: ${TAG[kind as Kind]}\nVALUE: ${value}\nAIM: ${aim}\nSAY: ${say}\nWHY: ${why}`,
        });
      } else if (kw === "x") {
        const [kind, tok, say, lat] = splitFields(arg);
        if (kind && !["answer", "prompt", "check", "fact"].includes(kind)) fail(`bad extra kind ${kind}`, lineNo);
        const mustMention = tok
          ? tok
              .split(";")
              .map((x) => x.trim())
              .filter(Boolean)
          : [];
        extras.push({
          id: `x${extras.length + 1}`,
          afterLine: id,
          ...(kind ? { kind: kind as Kind } : {}),
          ...(mustMention.length ? { mustMention } : {}),
          latestMs: Number(/latest=(\d+)/.exec(lat ?? "")?.[1] ?? 20000),
        });
        if (say)
          script.push({
            role: "moment",
            whenLastLine: id,
            ms: 1500,
            reply: `TAG: ${TAG[(kind || "fact") as Kind]}\nVALUE: 2\nAIM: me\nSAY: ${say}\nWHY: useful extra`,
          });
      } else if (kw === "mem") {
        script.push({ role: "memory", whenLastLine: id, ms: 700, reply: JSON.stringify(memPatch(arg, lines.at(-1)!.t, fail, lineNo)) });
      } else if (kw === "chk") {
        checks.push({
          atLine: id,
          mustContain: arg
            .split(";")
            .map((x) => x.trim())
            .filter(Boolean),
        });
      } else if (kw === "ask") {
        const [q, reply] = splitFields(arg);
        script.push({ role: "ask", whenLastLine: id, ms: 1200, q, reply });
      } else fail(`unknown label ${kw}`, lineNo);
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  // a script entry on a moment line wins over the SKIP of a neighbour; merge duplicate quiet+moment on one line cannot happen (builder checks)
  const silent: Golden["silent"] = [];
  for (let i = 0; i < quiet.length;) {
    let j = i;
    while (quiet[j + 1] === quiet[j] + 1) j++;
    silent.push({ fromLine: lines[quiet[i]].id, toLine: lines[quiet[j]].id });
    i = j + 1;
  }
  const context = hdr.context?.join(" ");
  if (context)
    script.unshift({
      role: "digest",
      whenLastLine: "start",
      ms: 1800,
      reply: JSON.stringify({
        roster: (hdr.roster ?? []).map((r) => {
          const [name, side, role] = r.split("|").map((x) => x.trim());
          return { name, side, ...(role ? { role } : {}) };
        }),
        agenda: hdr.agenda ?? [],
        facts: (hdr.brief ?? []).map((text) => ({ text, src: "brief" })),
        likelyQuestions: hdr.likely ?? [],
        chunks: [context],
      }),
    });
  const [userName, aliasS] = (hdr.user?.[0] ?? "Dan").split("|").map((x) => x.trim());
  const g: Golden = {
    id: one("id"),
    split: one("split") as Golden["split"],
    lang,
    type: one("type") as Golden["type"],
    variant: one("variant") as Golden["variant"],
    scripted: true,
    ...(context ? { context } : {}),
    profile: { userName, ...(aliasS ? { aliases: aliasS.split(",").map((x) => x.trim()) } : {}) },
    lines,
    moments,
    silent,
    ...(extras.length ? { allowedExtra: extras } : {}),
    ...(checks.length ? { memoryChecks: checks } : {}),
    script,
  };
  if (g.id !== file.replace(/\.txt$/, "")) fail(`id ${g.id} does not match the file name`);
  const noq = noqProblems(g);
  if (noq.length) throw new Error(noq.join("\n"));
  return GoldenSchema.parse(g);
}

function memPatch(arg: string, at: number, fail: (m: string, n?: number) => never, n: number) {
  const add: Record<string, object[]> = {};
  const patch: Record<string, unknown> = {};
  const push = (k: string, o: object) => (add[k] ??= []).push(o);
  for (const item of arg.split(" / ")) {
    const m = /^(n|c|f|q|o|d|topic):\s*(.*)$/.exec(item.trim());
    if (!m) fail(`bad mem item: ${item}`, n);
    const v = m![2];
    if (m![1] === "n") {
      const [what, value] = v.split("=");
      push("numbers", { what, value, at });
    } else if (m![1] === "c") {
      const [who, what, due] = v.split(">");
      push("commitments", { who, what, ...(due ? { due } : {}), at, status: "open" });
    } else if (m![1] === "f") push("facts", { text: v, at, src: "call" });
    else if (m![1] === "q") {
      const [asker, text] = v.split(">");
      push("openQuestions", { asker, text, at, status: "open" });
    } else if (m![1] === "o") {
      const [who, text] = v.split(">");
      push("objections", { who, text, at, handled: false });
    } else if (m![1] === "d") push("decisions", { text: v, at });
    else patch.topic = v;
  }
  if (Object.keys(add).length) patch.add = add;
  return patch;
}

export function buildAll(write = true): { golden: Golden[]; lock: string; locks: Record<string, string> } {
  const src = join(MEETINGS, "src");
  const errors: string[] = [];
  const golden: Golden[] = [];
  for (const f of readdirSync(src)
    .filter((x) => x.endsWith(".txt"))
    .sort()) {
    try {
      golden.push(parseMeeting(readFileSync(join(src, f), "utf8"), f));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  const texts = golden.map((g) => ({ g, name: `${g.id}.json`, text: JSON.stringify(g, null, 1) + "\n" }));
  const locks = Object.fromEntries(
    HELD_OUT.map((sp) => [sp, lockHash(texts.filter((x) => x.g.split === sp).map(({ name, text }) => ({ name, text })))]),
  ) as Record<string, string>;
  const lock = locks.test;
  if (write) {
    for (const s of SPLITS) {
      mkdirSync(join(MEETINGS, s), { recursive: true });
      for (const f of readdirSync(join(MEETINGS, s))) f.endsWith(".json") && rmSync(join(MEETINGS, s, f));
    }
    for (const x of texts) writeFileSync(join(MEETINGS, x.g.split, x.name), x.text);
    for (const sp of HELD_OUT) writeFileSync(join(MEETINGS, `${sp}.lock`), locks[sp] + "\n");
  }
  return { golden, lock, locks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { golden, locks } = buildAll();
  const mom = golden.reduce((s, g) => s + g.moments.length, 0);
  console.log(`${golden.length} meetings, ${mom} moments, test.lock ${locks.test.slice(0, 12)}, test-b.lock ${locks["test-b"].slice(0, 12)}`);
  existsSync(MEETINGS) || process.exit(1);
}
