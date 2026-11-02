// Fact cards (PLAN §0.5): when a known client or domain is mentioned, show what we know about it.
// Data comes from a local snapshot (data/private/entities.json, git-ignored), built before the call
// from the domains dashboard and client-kb. Nothing is looked up over the network during the call.
import { existsSync, readFileSync } from "node:fs";
import { normalize, tokens, tokenVariants } from "./normalize.ts";

/** Single words that are client aliases but also everyday speech: they only match as part of a longer alias. */
const GENERIC = new Set(["אתרים", "אתר", "תחנה", "נמל", "נחלה", "עתיד", "staging", "dev", "test",
  "design", "studio", "online", "digital", "media", "group", "travel", "energy", "health", "global", "systems", "solutions", "store", "shop", "hosting", "server", "cloud", "website"].map(normalize));
/** Subdomain labels that say nothing about the client. */
const SUBDOMAIN_NOISE = new Set(["www", "staging", "stage", "dev", "test", "old", "new", "mail", "api", "onboarding", "beta", "admin", "shop", "app", "m", "en", "he"]);
/** Second-level-ish name of a domain: "staging.example-c.com" -> "example-c", "example-b.co.il" -> "example-b". */
export function domainBase(domain: string): string {
  const labels = domain.toLowerCase().split(".");
  const twoPartTld = labels.length >= 3 && ["co", "org", "net", "ac", "gov", "muni", "k12"].includes(labels[labels.length - 2]);
  return labels[labels.length - (twoPartTld ? 3 : 2)] ?? labels[0];
}
/** Apex domains first, then fewer labels; noisy subdomains (old., staging.) last. */
function domainRank(d: string): number {
  const labels = d.split(".");
  return (SUBDOMAIN_NOISE.has(labels[0]) ? 10 : 0) + labels.length;
}
/** Alias tokens must appear in order; the alias side is exact, the spoken side may carry a Hebrew prefix ("מסייפלט"). */
export function aliasMatch(text: string, alias: string): boolean {
  const want = tokens(alias);
  if (!want.length) return false;
  const said = tokens(text).map(tokenVariants);
  for (let i = 0; i + want.length <= said.length; i++) if (want.every((w, j) => said[i + j].includes(w))) return true;
  return false;
}

export type Client = { id: number; name: string; aliases: string[]; domains?: string[]; note?: string | null };
export type Domain = {
  domain: string; clientId?: number | null; server?: string | null; cms?: string | null; cmsVersion?: string | null;
  php?: string | null; sslExpires?: string | null; suspended?: boolean | null;
};
export type Snapshot = { generatedAt?: string; clients: Client[]; domains: Domain[] };
export type Fact = { key: string; kind: "client" | "domain"; title: string; lines: string[]; clientId?: number; warn: boolean };

export function loadSnapshot(file: string): Snapshot | undefined {
  if (!existsSync(file)) return undefined;
  const s = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  return { generatedAt: s.generatedAt, clients: s.clients ?? [], domains: s.domains ?? [] };
}

/** Days from `now` until an ISO date (negative = past). */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.floor((Date.parse(iso) - now) / 86_400_000);
}

export class EntitySpotter {
  private byClient = new Map<number, Client>();
  private byDomain = new Map<string, Domain>();
  /** Latin domain base ("example-b" of example-b.co.il) -> domain, for people saying the name without the ending. */
  private byBase = new Map<string, Domain>();
  constructor(private snap: Snapshot, private o: { sslWarnDays: number; minAliasLen: number }) {
    for (const c of snap.clients) this.byClient.set(c.id, c);
    for (const d of snap.domains) {
      this.byDomain.set(d.domain.toLowerCase(), d);
      const base = domainBase(d.domain);
      if (base.length >= 5 && !GENERIC.has(base)) {
        const prev = this.byBase.get(base);
        if (!prev || domainRank(d.domain) < domainRank(prev.domain)) this.byBase.set(base, d);
      }
    }
  }
  get size() { return { clients: this.snap.clients.length, domains: this.snap.domains.length }; }

  /** Every client/domain mentioned in this text. Domains first (more specific). */
  spot(text: string, captured: string[] = []): Fact[] {
    const out = new Map<string, Fact>();
    const norm = normalize(text);
    const words = new Set(norm.split(" "));
    for (const v of captured) { const d = this.byDomain.get(v.toLowerCase()); if (d) out.set(`d:${d.domain}`, this.domainFact(d)); }
    const padded = ` ${norm} `;
    // normalize() turns "-" into a space, so a hyphenated base ("my-store") is matched as its spoken words ("my store").
    for (const [base, d] of this.byBase) if (words.has(base) || (base.includes("-") && padded.includes(` ${normalize(base)} `))) out.set(`d:${d.domain}`, this.domainFact(d));
    for (const c of this.snap.clients) {
      const hit = (c.aliases ?? []).some((a) => {
        if (typeof a !== "string") return false;
        const n = normalize(a);
        if (n.replace(/\s/g, "").length < this.o.minAliasLen) return false;
        if (!n.includes(" ") && GENERIC.has(n)) return false;
        return aliasMatch(text, a);
      });
      if (hit) out.set(`c:${c.id}`, this.clientFact(c));
    }
    // A domain of an already-spotted client adds nothing new: keep the client card.
    for (const [k, f] of out) if (f.kind === "domain" && f.clientId !== undefined && out.has(`c:${f.clientId}`)) out.delete(k);
    return [...out.values()];
  }

  clientFact(c: Client): Fact {
    const doms = this.snap.domains.filter((d) => d.clientId === c.id || c.domains?.includes(d.domain)).sort((a, b) => domainRank(a.domain) - domainRank(b.domain));
    const lines = doms.slice(0, 4).map((d) => this.domainLine(d));
    if (doms.length > 4) lines.push(`ועוד ${doms.length - 4} אתרים`);
    if (c.note) lines.push(c.note);
    return { key: `c:${c.id}`, kind: "client", title: c.name, lines, clientId: c.id, warn: doms.some((d) => this.sslWarn(d)) };
  }
  domainFact(d: Domain): Fact {
    const client = d.clientId != null ? this.byClient.get(d.clientId) : undefined;
    const lines = [this.domainLine(d, false)];
    if (d.server) lines.push(`שרת: ${d.server}`);
    if (client?.note) lines.push(client.note);
    return { key: `d:${d.domain}`, kind: "domain", title: client ? `${d.domain} · ${client.name}` : d.domain, lines, clientId: d.clientId ?? undefined, warn: this.sslWarn(d) };
  }
  private sslWarn(d: Domain): boolean { if (!d.sslExpires) return false; const n = daysUntil(d.sslExpires); return n >= -30 && n <= this.o.sslWarnDays; }
  private domainLine(d: Domain, withName = true): string {
    const parts: string[] = [];
    if (withName) parts.push(d.domain);
    if (d.cms) parts.push(d.cmsVersion ? `${d.cms} ${d.cmsVersion}` : d.cms);
    if (d.php) parts.push(`PHP ${d.php}`);
    // A date long past is stale dashboard data (old certificate record), not news: show it only if recent.
    if (d.sslExpires && daysUntil(d.sslExpires) >= -30) {
      const n = daysUntil(d.sslExpires);
      parts.push(n < 0 ? `⚠ SSL פג לפני ${-n} ימים` : n <= this.o.sslWarnDays ? `⚠ SSL פג בעוד ${n} ימים` : `SSL עד ${d.sslExpires.slice(0, 10)}`);
    }
    if (d.suspended) parts.push("⚠ מושעה");
    return parts.join(" · ");
  }
}
