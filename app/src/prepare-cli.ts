// Child process for the Wingman window's "Prepare" button (dashboard/prepare.cjs): turn the meeting context into a digest and save it as digest.json next to the plan.
// stdin: { out, lang, plan: { title, who, goal, notes, mustCover } }. WINGMAN_ATTACH_DIR names the plan's files folder (pasted context and background files).
// stdout: one JSON line: { ok: true, digest: boolean, reason?, counts? }. It never prints call or file text. It makes one model call, through runDigest (src/digest.ts), only when that module exists.
// WINGMAN_DIGEST_MODULE replaces the module path (tests use a fake that makes no network call).
import { loadAttachments } from "./attachments.ts";
import { cleanDigest, writeDigestFile } from "./session/digest-file.ts";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const MAX_CHARS = 60_000;
type Plan = { title?: string; who?: string; goal?: string; notes?: string; mustCover?: string };

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
  if (!text.trim()) return out({ ok: true, digest: false, reason: "empty" });
  let mod: { runDigest?: (i: Record<string, unknown>) => Promise<unknown> } | undefined;
  try {
    const spec = process.env.WINGMAN_DIGEST_MODULE || "./digest.ts";
    mod = (await import(spec)) as typeof mod;
  } catch {
    mod = undefined;
  }
  if (!mod || typeof mod.runDigest !== "function") return out({ ok: true, digest: false, reason: "no-digest" });
  let res: unknown;
  try {
    res = await mod.runDigest({ text, lang: input.lang === "he" ? "he" : "en", mustCover: p.mustCover ?? "", who: p.who ?? "", goal: p.goal ?? "" });
  } catch (e) {
    return out({ ok: true, digest: false, reason: "failed", message: String((e as Error)?.message ?? e).slice(0, 160) });
  }
  const r = res as { digest?: unknown; ok?: boolean } | null;
  const d = cleanDigest(r && typeof r === "object" && "digest" in r ? r.digest : res);
  if (!d) return out({ ok: true, digest: false, reason: "raw" }); // the digest could not be made: the text stays plain background
  writeDigestFile(input.out, d);
  out({ ok: true, digest: true, counts: { roster: d.roster.length, agenda: d.agenda.length, facts: d.facts.length, chunks: d.chunks.length } });
}
main().catch((e) => out({ ok: false, message: String((e as Error)?.message ?? e).slice(0, 200) }));
