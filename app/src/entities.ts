// SCOPE (round 12): the legacy engine and agency-style calls only. The client snapshot and the GENERIC name list here are private, local data for fact
// cards. They are not part of the call memory (session/), and the v2 engine does not read them for context. Do not present them as the context model.
// Fact cards: when a known client or domain is mentioned in the transcript, show what we know about it (hosting, CMS, PHP, SSL).
// Data comes from a local snapshot (data/private/entities.json, git-ignored) that you build before the call from your own
// client/domain lists. Nothing is looked up over the network during the call. Used by run.ts; matching reuses normalize.ts.
// Client names and aliases live only in that private file, never in code.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ht, type UiLang } from "./htext.ts";
import { normalize, tokens, tokenVariants } from "./normalize.ts";

/** Everyday words that some client aliases are made of: alone they only match as part of a longer alias.
 *  Words that are generic only for YOUR client list (a client called "The Garage", say) go in a
 *  `generic-aliases.txt` file next to the snapshot, one per line, so client names never live in the code. */
const GENERIC = new Set(
  [
    "אתרים",
    "אתר",
    "תחנה",
    "נמל",
    "נחלה",
    "עתיד",
    "staging",
    "dev",
    "test",
    "design",
    "studio",
    "online",
    "digital",
    "media",
    "group",
    "travel",
    "energy",
    "health",
    "global",
    "systems",
    "solutions",
    "store",
    "shop",
    "hosting",
    "server",
    "cloud",
    "website",
  ].map(normalize),
);
/** Subdomain labels that say nothing about the client. */
const SUBDOMAIN_NOISE = new Set([
  "www",
  "staging",
  "stage",
  "dev",
  "test",
  "old",
  "new",
  "mail",
  "api",
  "onboarding",
  "beta",
  "admin",
  "shop",
  "app",
  "m",
  "en",
  "he",
]);
/** Second-level-ish name of a domain: "staging.example-shop.com" -> "example-shop", "acme.co.il" -> "acme". Handles two-part TLDs (co.il, org.il...). */
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
/** Alias tokens must appear in order; the alias side is exact, the spoken side may carry a Hebrew prefix ("מאקמי" = מ + אקמי). */
export function aliasMatch(text: string, alias: string): boolean {
  const want = tokens(alias);
  if (!want.length) return false;
  const said = tokens(text).map(tokenVariants);
  for (let i = 0; i + want.length <= said.length; i++) if (want.every((w, j) => said[i + j].includes(w))) return true;
  return false;
}

export type Client = { id: number; name: string; aliases: string[]; domains?: string[]; note?: string | null };
export type Domain = {
  domain: string;
  clientId?: number | null;
  server?: string | null;
  cms?: string | null;
  cmsVersion?: string | null;
  php?: string | null;
  sslExpires?: string | null;
  suspended?: boolean | null;
};
export type Snapshot = { generatedAt?: string; clients: Client[]; domains: Domain[]; genericAliases?: string[] };
export type Fact = { key: string; kind: "client" | "domain"; title: string; lines: string[]; clientId?: number; warn: boolean };

/** Reads the snapshot JSON (undefined if the file is missing) plus the optional `generic-aliases.txt` next to it (one word per line, `#` comments). */
export function loadSnapshot(file: string): Snapshot | undefined {
  if (!existsSync(file)) return undefined;
  const s = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  const sidecar = join(dirname(file), "generic-aliases.txt");
  const genericAliases = existsSync(sidecar)
    ? readFileSync(sidecar, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [];
  return { generatedAt: s.generatedAt, clients: s.clients ?? [], domains: s.domains ?? [], genericAliases };
}

/** Days from `now` until an ISO date (negative = past). */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.floor((Date.parse(iso) - now) / 86_400_000);
}

/** Finds clients and domains in free text and turns them into short Hebrew fact cards. Built once per call from a Snapshot. */
export class EntitySpotter {
  private byClient = new Map<number, Client>();
  private byDomain = new Map<string, Domain>();
  /** Latin domain base ("acme" of acme.co.il) -> domain, for people saying the name without the ending. */
  private byBase = new Map<string, Domain>();
  /** GENERIC plus the snapshot's own generic words. */
  private generic: Set<string>;
  constructor(
    private snap: Snapshot,
    private o: { sslWarnDays: number; minAliasLen: number; lang?: UiLang },
  ) {
    this.generic = new Set([...GENERIC, ...(snap.genericAliases ?? []).map(normalize)]);
    for (const c of snap.clients) this.byClient.set(c.id, c);
    for (const d of snap.domains) {
      this.byDomain.set(d.domain.toLowerCase(), d);
      const base = domainBase(d.domain);
      if (base.length >= 5 && !this.generic.has(base)) {
        const prev = this.byBase.get(base);
        if (!prev || domainRank(d.domain) < domainRank(prev.domain)) this.byBase.set(base, d);
      }
    }
  }
  get size() {
    return { clients: this.snap.clients.length, domains: this.snap.domains.length };
  }

  /** Every client/domain mentioned in this text. Domains first (more specific). `captured` = domains already extracted from the text as full domain names. */
  spot(text: string, captured: string[] = []): Fact[] {
    const out = new Map<string, Fact>();
    const norm = normalize(text);
    const words = new Set(norm.split(" "));
    for (const v of captured) {
      const d = this.byDomain.get(v.toLowerCase());
      if (d) out.set(`d:${d.domain}`, this.domainFact(d));
    }
    const padded = ` ${norm} `;
    // normalize() turns "-" into a space, so a hyphenated base ("my-store") is matched as its spoken words ("my store").
    for (const [base, d] of this.byBase)
      if (words.has(base) || (base.includes("-") && padded.includes(` ${normalize(base)} `))) out.set(`d:${d.domain}`, this.domainFact(d));
    for (const c of this.snap.clients) {
      const hit = (c.aliases ?? []).some((a) => {
        if (typeof a !== "string") return false;
        const n = normalize(a);
        if (n.replace(/\s/g, "").length < this.o.minAliasLen) return false;
        if (!n.includes(" ") && this.generic.has(n)) return false;
        return aliasMatch(text, a);
      });
      if (hit) out.set(`c:${c.id}`, this.clientFact(c));
    }
    // A domain of an already-spotted client adds nothing new: keep the client card.
    for (const [k, f] of out) if (f.kind === "domain" && f.clientId !== undefined && out.has(`c:${f.clientId}`)) out.delete(k);
    return [...out.values()];
  }

  /** Card for a client: up to 4 domain lines (+ a "more" line) and the client note. `warn` when any SSL expires soon. */
  clientFact(c: Client): Fact {
    const doms = this.snap.domains
      .filter((d) => d.clientId === c.id || c.domains?.includes(d.domain))
      .sort((a, b) => domainRank(a.domain) - domainRank(b.domain));
    const lines = doms.slice(0, 4).map((d) => this.domainLine(d));
    if (doms.length > 4) lines.push(ht(this.o.lang, "fact.more", { n: doms.length - 4 }));
    if (c.note) lines.push(c.note);
    return { key: `c:${c.id}`, kind: "client", title: c.name, lines, clientId: c.id, warn: doms.some((d) => this.sslWarn(d)) };
  }
  /** Card for one domain, with its owner client's name and note when known. */
  domainFact(d: Domain): Fact {
    const client = d.clientId != null ? this.byClient.get(d.clientId) : undefined;
    const lines = [this.domainLine(d, false)];
    if (d.server) lines.push(ht(this.o.lang, "fact.server", { v: d.server }));
    if (client?.note) lines.push(client.note);
    return {
      key: `d:${d.domain}`,
      kind: "domain",
      title: client ? `${d.domain} · ${client.name}` : d.domain,
      lines,
      clientId: d.clientId ?? undefined,
      warn: this.sslWarn(d),
    };
  }
  /** Warn when the certificate expires within sslWarnDays or expired in the last 30 days (older dates are stale data). */
  private sslWarn(d: Domain): boolean {
    if (!d.sslExpires) return false;
    const n = daysUntil(d.sslExpires);
    return n >= -30 && n <= this.o.sslWarnDays;
  }
  private domainLine(d: Domain, withName = true): string {
    const parts: string[] = [];
    if (withName) parts.push(d.domain);
    if (d.cms) parts.push(d.cmsVersion ? `${d.cms} ${d.cmsVersion}` : d.cms);
    if (d.php) parts.push(`PHP ${d.php}`);
    // A date long past is stale dashboard data (old certificate record), not news: show it only if recent.
    if (d.sslExpires && daysUntil(d.sslExpires) >= -30) {
      const n = daysUntil(d.sslExpires);
      const L = this.o.lang;
      parts.push(
        n < 0
          ? ht(L, "fact.sslExpired", { n: -n })
          : n <= this.o.sslWarnDays
            ? ht(L, "fact.sslSoon", { n })
            : ht(L, "fact.sslUntil", { date: d.sslExpires.slice(0, 10) }),
      );
    }
    if (d.suspended) parts.push(ht(this.o.lang, "fact.suspended"));
    return parts.join(" · ");
  }
}
