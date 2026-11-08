// Prompt snapshots: the prompt of each model role is rendered to text and compared with a committed file, so a prompt change shows up as a reviewed diff.
//   assertPromptSnapshot("moment", { system, messages: [{ role: "user", content }] });
// Files live in data/snapshots/prompts/<name>.txt. Review the diff of the .txt file in the commit. To accept a change run the test with
// WINGMAN_UPDATE_SNAPSHOTS=1 (it rewrites the files), then read `git diff`. A missing file fails the test the same way (run with the flag to create it).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT } from "../env.ts";
import { viewOf, renderView, type CallOptions } from "./prompt.ts";
import { diffLines } from "../providers/cassette.ts";

export const SNAPSHOT_DIR = join(ROOT, "data", "snapshots", "prompts");

/** Renders a prompt (system text + messages) the way a model would see it, as stable text. `scrub` hides volatile parts such as dates (default: ISO dates and clock times). */
export function renderPrompt(
  role: string,
  p: { system: string; messages?: { role: string; content: string }[]; user?: string },
  scrub: (s: string) => string = defaultScrub,
): string {
  const call: CallOptions = {
    prompt: [{ role: "system", content: p.system }, ...(p.messages ?? (p.user !== undefined ? [{ role: "user", content: p.user }] : []))],
    providerOptions: { wingman: { role } },
  };
  return scrub(renderView(viewOf("snapshot", call))) + "\n";
}
export const defaultScrub = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/g, "<date>").replace(/\b\d{1,2}:\d{2}\b/g, "<time>");

export function assertPromptSnapshot(
  name: string,
  p: Parameters<typeof renderPrompt>[1],
  o: { dir?: string; update?: boolean; scrub?: (s: string) => string } = {},
) {
  const file = join(o.dir ?? SNAPSHOT_DIR, `${name}.txt`);
  const now = renderPrompt(name, p, o.scrub);
  const update = o.update ?? process.env.WINGMAN_UPDATE_SNAPSHOTS === "1";
  if (!existsSync(file)) {
    if (!update) throw new Error(`Prompt snapshot ${name} does not exist (${file}). Run with WINGMAN_UPDATE_SNAPSHOTS=1 to create it, then review it.`);
  } else {
    const was = readFileSync(file, "utf8");
    if (was === now) return;
    if (!update)
      throw new Error(
        `Prompt snapshot ${name} changed (${file}). Diff (- committed, + now):\n${diffLines(was.split("\n"), now.split("\n"))}\nIf the change is intended, run with WINGMAN_UPDATE_SNAPSHOTS=1 and commit the file.`,
      );
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, now);
}
