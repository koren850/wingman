// The first things a stranger reads must be current: links and images resolve, ADR anchors exist, and no internal wording leaks in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const FILES = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/ROADMAP.md",
  "docs/GETTING-STARTED.md",
  "docs/RECORDING-EVALS.md",
  "docs/PRIVACY-AND-SECURITY.md",
  "docs/EXAMPLES.md",
  "docs/PACK-FORMAT.md",
  "app/README.md",
  "app/CALL-DAY.md",
  "app/data/meetings/README.md",
  "app/data/judge-set/README.md",
];
// Images that are added by the screenshot work and may not be in the tree yet.
const PENDING_IMAGES = new Set(["docs/ux/answer-window-he.png", "docs/ux/home-live.png"]);
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** The anchor GitHub makes for a heading. */
function slug(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}
function anchors(rel: string): Set<string> {
  const out = new Set<string>();
  let fence = false;
  for (const line of read(rel).split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(line);
    if (m) out.add(slug(m[1]!));
  }
  return out;
}
function links(rel: string): string[] {
  const text = read(rel).replace(/```[\s\S]*?```/g, "");
  return [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
}

test("relative links, images and anchors in the front docs resolve", () => {
  for (const rel of FILES) {
    for (const href of links(rel)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [path, frag] = href.split("#");
      const target = path ? join(dirname(rel), path) : rel;
      if (PENDING_IMAGES.has(target)) continue;
      assert.ok(existsSync(join(ROOT, target)), `${rel}: ${href} does not exist`);
      if (frag && target.endsWith(".md")) assert.ok(anchors(target).has(frag), `${rel}: anchor #${frag} is not a heading in ${target}`);
    }
  }
});

test("front docs have no internal wording", () => {
  const banned = new RegExp(
    [
      "stage" + "0",
      "round [0-9]",
      "r3-docs-" + "gates",
      "\\bthe own" + "er\\b",
      "MORNING" + "-KIT",
      "[Mm]orning kit",
      "PLAN sec" + "tion",
      "build re" + "port",
      "wave [0-9]",
    ].join("|"),
  );
  for (const rel of FILES) assert.ok(!banned.test(read(rel)), `${rel} has internal wording: ${banned.exec(read(rel))?.[0]}`);
});

test("the changelog has one section, 0.0.1, marked unreleased until the release is published", () => {
  const text = read("CHANGELOG.md");
  assert.match(text, /^## 0\.0\.1 - unreleased\n/m);
  assert.ok(!/^## Unreleased$/m.test(text), "no separate Unreleased section");
});

test("the privacy doc lists the three opt-in network features and does not claim no other host", () => {
  const text = read("docs/PRIVACY-AND-SECURITY.md");
  assert.ok(!/no other host is contacted/.test(text));
  for (const word of ["web address as context", "calendar link", "Web lookup"]) assert.ok(text.includes(word), word);
  assert.ok(text.includes("By default nothing else is sent"));
});

test("front docs agree on the numbers of the fact sheet", () => {
  const all = FILES.map(read).join("\n");
  assert.ok(!/\b65 architecture decision/.test(all));
  assert.ok(!/29 options/.test(all));
  assert.ok(!/English only/.test(read("app/README.md")));
  assert.ok(read("CHANGELOG.md").includes("71 architecture decision records"));
});
