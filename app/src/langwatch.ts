// Language watch: tells the user ONCE when the call is in a language Wingman does not understand (it knows English and Hebrew).
// Two cases, both counted over a streak of finals with no Hebrew or English line in between:
//  - "foreign": finals in another script (Russian, Arabic...). They are already dropped by stt.dropForeignScript.
//  - "latin": finals in a Latin-script language that is not English (Spanish, French...). They pass the script filter, but no question is ever detected.
// The Latin test is cheap: a line of 4+ words with almost none of the common English function words. Hebrew lines always count as supported.
import { checkScript } from "./lang.ts";

const HEBREW = /[֐-׿]/;
// Common English function words. Words that are also common in Spanish/French/Italian/German (a, no, me, he, so, in, an, die, was) are left out on purpose.
const EN = new Set(
  "thanks thank bye hello hi please sorry great good now one two three the and is are was were you your to of it that this for on with we they have has had be been not but at if can could would should will do does did what how why when where who which there their here from about just like yes okay so because or by as my our its them then than too very really also".split(
    " ",
  ),
);
// Function words of Spanish, French, Italian, German and Portuguese that are not English words. A Latin line counts as "not English" only with real evidence of this kind,
// so a line made of names and product words (Salesforce HubSpot Zapier) is never taken for another language.
const OTHER = new Set(
  (
    "el los las una unos unas del que para por con es son está estoy pero como muy más buenos buenas días hola gracias quería queremos nuestra nuestro cuánto cuesta " +
    "le les des du est sont pour vous nous votre notre dans sur pas ne ce qui il elle je tu bonjour merci voudrais savoir combien avec " +
    "ich und der das nicht ist ein eine mit für auf wir sie ihr haben wie was ob " +
    "che sono non gli della dello della buongiorno grazie vorrei " +
    "uma não os com são você obrigado olá"
  ).split(" "),
);
const words = (t: string) => t.toLowerCase().match(/[\p{L}']+/gu) ?? [];

export type FinalKind = "foreign" | "latin" | "supported" | "neutral";

/** What one final says about the call language. Short or empty lines are neutral (they decide nothing). */
export function classifyFinal(text: string): FinalKind {
  const sc = checkScript(text);
  if (!sc.ok) return sc.foreign >= 6 ? "foreign" : "neutral";
  const w = words(text);
  if (HEBREW.test(text)) return w.length >= 3 ? "supported" : "neutral";
  if (w.length < 4) return "neutral";
  const en = w.filter((x) => EN.has(x)).length;
  if (en >= 2 || en / w.length >= 0.2) return "supported";
  // Names and products: most words are capitalised or hold digits. That decides nothing.
  const raw = text.match(/[\p{L}\p{N}']+/gu) ?? [];
  const nameLike = raw.filter((x) => /^\p{Lu}/u.test(x) || /\d/.test(x)).length;
  if (nameLike * 2 > raw.length) return "neutral";
  return w.filter((x) => OTHER.has(x)).length >= 2 ? "latin" : "neutral";
}

export type LangWatchOptions = { foreignCount?: number; foreignWindowMs?: number; latinCount?: number; latinWindowMs?: number; maxShows?: number };

/** Streak counter. `note()` returns "show" the moment the notice should appear, "clear" when it may go away, else null. */
export class LangWatch {
  readonly counts = { foreign: 0, latin: 0, notices: 0 };
  private streak: { kind: "foreign" | "latin"; times: number[] } = { kind: "foreign", times: [] };
  private shown = false;
  private okRun = 0;
  private o: Required<LangWatchOptions>;
  constructor(opts: LangWatchOptions = {}) {
    this.o = { foreignCount: 3, foreignWindowMs: 60_000, latinCount: 4, latinWindowMs: 90_000, maxShows: 3, ...opts };
  }
  note(text: string, now = Date.now()): "show" | "clear" | null {
    const k = classifyFinal(text);
    if (k === "neutral") return null;
    if (k === "supported") {
      this.streak.times = [];
      if (this.shown && ++this.okRun >= 2) {
        this.shown = false;
        this.okRun = 0;
        return "clear";
      }
      return null;
    }
    this.counts[k]++;
    this.okRun = 0;
    if (this.streak.kind !== k) this.streak = { kind: k, times: [] };
    const win = k === "foreign" ? this.o.foreignWindowMs : this.o.latinWindowMs,
      need = k === "foreign" ? this.o.foreignCount : this.o.latinCount;
    this.streak.times = [...this.streak.times.filter((t) => now - t <= win), now];
    if (this.streak.times.length >= need && !this.shown && this.counts.notices < this.o.maxShows) {
      this.shown = true;
      this.counts.notices++;
      this.streak.times = [];
      return "show";
    }
    return null;
  }
}
