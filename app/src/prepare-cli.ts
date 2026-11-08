// Child process for the Wingman window's "Prepare" button (dashboard/prepare.cjs): turn the meeting context into a digest and save it as digest.json next to the plan.
// stdin: { out, lang, plan: { title, who, goal, notes, mustCover } }. WINGMAN_ATTACH_DIR names the plan's files folder (pasted context, files, web pages, calendar text).
// stdout: one JSON line: { ok: true, digest: boolean, reason?, counts? }. It never prints call or file text.
// It makes at most ONE model call, the digest (src/digest.ts runDigest, model digest.model), on the same capped input as before (60,000 characters).
// "Last time" facts about people on the call (session/people.ts) are added to the digest without any model call, so a plan with a known name has a
// digest even when the model is off.
// WINGMAN_DIGEST_MODULE replaces the digest module with one that takes the plain input (tests use a fake that makes no network call).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadAttachments } from "./attachments.ts";
import { CALLS, USER_DATA, loadKeys, type KeyName } from "./env.ts";
import { realKeychain } from "./keychain.ts";
import { ModelRegistry, parseModelRef } from "./providers/llm.ts";
import { expandHome, loadSettings } from "./settings.ts";
import { cleanDigest, writeDigestFile } from "./session/digest-file.ts";
import { indexFinishedCalls, namesForCall, pastFactsFor, PEOPLE_FILE } from "./session/people.ts";
import { emptyDigest, type Digest } from "./session/seed.ts";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const MAX_CHARS = 60_000;
type Plan = { title?: string; who?: string; goal?: string; notes?: string; mustCover?: string };
type Input = { text: string; lang: "he" | "en"; mustCover: string; who: string; goal: string };

/** The real digest: one model call through runDigest. No key or a down model gives a raw digest (chunks only), which is reported as "raw". */
async function realDigest(i: Input): Promise<unknown> {
  const { runDigest } = await import("./digest.ts");
  const S = loadSettings({ argv: [], env: process.env }).settings;
  const model = S.digest.model;
  const provider = parseModelRef(model).provider;
  const keys = loadKeys(expandHome(S.keys.file), process.env, provider === "scripted" ? null : realKeychain());
  const have = provider === "scripted" || !!keys[provider as KeyName];
  return runDigest({ text: i.text }, { registry: new ModelRegistry(keys), models: have ? [model] : [] });
}

async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const input = JSON.parse(raw) as { out?: string; lang?: string; plan?: Plan };
  if (!input || typeof input.out !== "string" || !input.out) throw new Error("bad input");
  const p: Plan = input.plan ?? {};
  const head = [
    p.title && `Title: ${p.title}`,
    p.who && `Who joins: ${p.who}`,
    p.goal && `Goal: ${p.goal}`,
    p.notes && `Notes: ${p.notes}`,
    p.mustCover && `Must cover: ${p.mustCover}`,
  ].filter(Boolean);
  const files = loadAttachments(MAX_CHARS);
  const text = [...head, ...files.map((f) => `--- ${f.name}\n${f.text}`)].join("\n").slice(0, MAX_CHARS);
  if (!text.trim()) {
    rmSync(input.out, { force: true });
    return out({ ok: true, digest: false, reason: "empty" });
  }
  const payload: Input = { text, lang: input.lang === "he" ? "he" : "en", mustCover: p.mustCover ?? "", who: p.who ?? "", goal: p.goal ?? "" };
  let reason = "";
  let message = "";
  let d: Digest | null = null;
  const spec = process.env.WINGMAN_DIGEST_MODULE;
  try {
    let res: unknown;
    if (spec) {
      const mod = (await import(spec).catch(() => undefined)) as { runDigest?: (i: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (!mod || typeof mod.runDigest !== "function") reason = "no-digest";
      else res = await mod.runDigest({ ...payload });
    } else res = await realDigest(payload);
    if (!reason) {
      const r = res as { digest?: unknown; source?: string; why?: string } | null;
      // a digest made without the model (no key, model down) holds only the raw text: it is plain background, not a digest
      if (r && typeof r === "object" && r.source === "raw") reason = r.why === "timeout" ? "timeout" : "raw";
      else {
        d = cleanDigest(r && typeof r === "object" && "digest" in r ? r.digest : res);
        if (!d) reason = "raw";
      }
    }
  } catch (e) {
    reason = "failed";
    message = String((e as Error)?.message ?? e).slice(0, 160);
  }
  // Last time: people on the call who were on earlier calls. Local, no model.
  let past: Digest["past"] = [];
  try {
    if (loadSettings({ argv: [], env: process.env }).settings.context.pastCalls) {
      const file = join(USER_DATA, PEOPLE_FILE);
      indexFinishedCalls({ callsDir: CALLS, file });
      const names = namesForCall(d?.roster, p.who);
      past = names.length ? pastFactsFor(names, { file }) : [];
    }
  } catch {
    past = [];
  }
  if (!d && !past?.length) {
    rmSync(input.out, { force: true }); // a digest from an earlier Prepare must not stay and look current
    return out({ ok: true, digest: false, reason: reason || "raw", ...(message ? { message } : {}) });
  }
  const final: Digest = { ...(d ?? emptyDigest()), ...(past?.length ? { past } : {}) };
  writeDigestFile(input.out, final);
  out({
    ok: true,
    digest: !!d,
    ...(!d ? { reason: reason || "raw" } : {}),
    counts: { roster: final.roster.length, agenda: final.agenda.length, facts: final.facts.length, chunks: final.chunks.length, past: final.past?.length ?? 0 },
  });
}
main().catch((e) => out({ ok: false, message: String((e as Error)?.message ?? e).slice(0, 200) }));
