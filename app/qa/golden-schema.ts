// The golden meeting file (PLAN 3.4) as a zod schema, plus the plain type. Used by the loader, the builder and the tests.
// Extensions over the plan (all optional): `scripted` on the file, `tags` and `direct` on a moment, `q` on an ask script entry.
import { z } from "zod";

export const KINDS = ["answer", "prompt", "check", "fact"] as const;
export const TYPES = ["sales", "pricing", "support", "vendor", "standup", "one2one", "kickoff", "interview"] as const;

const Line = z.object({
  id: z.string().regex(/^l\d+$/),
  t: z.number().int().nonnegative(), // ms since the start of the meeting when this line is final (the speech has ended)
  side: z.enum(["me", "them"]),
  speaker: z.string().optional(),
  text: z.string().min(1),
});
const Moment = z.object({
  id: z.string().regex(/^m\d+$/),
  afterLine: z.string(),
  kind: z.enum(KINDS),
  mustMention: z.array(z.string().min(1)).optional(),
  latestMs: z.number().int().positive(), // the card must show within this many ms after the line is final
  direct: z.boolean().optional(), // a question put to the user: counts for direct-question recall
  tags: z.array(z.string()).optional(), // implied, objection, number-conflict, promise, jargon, topic-shift, unanswered ...
});
const Script = z.object({
  role: z.enum(["moment", "memory", "ask", "digest"]),
  whenLastLine: z.string(), // a line id, or "start" for the digest
  reply: z.string(),
  ms: z.number().int().nonnegative().optional(),
  q: z.string().optional(), // for role "ask": the question typed by the user
});

export const GoldenSchema = z
  .object({
    id: z.string().regex(/^(dev|test)-[a-z0-9-]+$/),
    split: z.enum(["dev", "test"]),
    lang: z.enum(["en", "he", "mixed"]),
    type: z.enum(TYPES),
    variant: z.enum(["clean", "noisy"]),
    scripted: z.boolean().optional(),
    context: z.string().optional(),
    profile: z.object({ userName: z.string(), aliases: z.array(z.string()).optional() }).optional(),
    lines: z.array(Line).min(10),
    moments: z.array(Moment),
    silent: z.array(z.object({ fromLine: z.string(), toLine: z.string() })),
    memoryChecks: z.array(z.object({ atLine: z.string(), mustContain: z.array(z.string().min(1)).min(1) })).optional(),
    script: z.array(Script).optional(),
  })
  .superRefine((g, ctx) => {
    const ids = new Set(g.lines.map((l) => l.id));
    const bad = (m: string) => ctx.addIssue({ code: "custom", message: m });
    if (ids.size !== g.lines.length) bad("duplicate line id");
    g.lines.forEach((l, i) => i && l.t < g.lines[i - 1].t && bad(`line ${l.id} goes back in time`));
    for (const m of g.moments) ids.has(m.afterLine) || bad(`moment ${m.id}: unknown line ${m.afterLine}`);
    for (const s of g.silent) (ids.has(s.fromLine) && ids.has(s.toLine)) || bad(`silent window ${s.fromLine}-${s.toLine}: unknown line`);
    for (const c of g.memoryChecks ?? []) ids.has(c.atLine) || bad(`memory check: unknown line ${c.atLine}`);
    for (const s of g.script ?? []) s.whenLastLine === "start" || ids.has(s.whenLastLine) || bad(`script: unknown line ${s.whenLastLine}`);
  });

export type Golden = z.infer<typeof GoldenSchema>;
export type Kind = (typeof KINDS)[number];
