// Texts of the engine's own cards (failed ask, consent, tips, reminders), in the UI language. The words live in src/htext.ts (EN and HE);
// this file only picks the language. A test (engine-strings.test.ts) keeps Hebrew letters out of the string literals of src/engine/*.ts.
import { ht } from "../htext.ts";
import { UI_LANG } from "./boot.ts";

export const askError = () => ht(UI_LANG, "ask.error");
export const consentTitle = () => ht(UI_LANG, "consent.title");
export const consentSayIt = () => ht(UI_LANG, "consent.sayit");
export const consentStop = (control: boolean) => ht(UI_LANG, control ? "consent.stop.ctl" : "consent.stop.tty");
export const consentStart = (control: boolean) => ht(UI_LANG, control ? "consent.start.ctl" : "consent.start.tty");
export const consentStarted = () => ht(UI_LANG, "consent.started");
export const longAnswerTip = () => ht(UI_LANG, "tip.long");
export const proposeClient = (title: string) => ht(UI_LANG, "side.propose", { name: title });
export const proposeClientHow = (control: boolean) => ht(UI_LANG, control ? "side.propose.ctl" : "side.propose.tty");
export const reminderTitle = () => ht(UI_LANG, "side.reminder");
export const reminderMore = (n: number) => ht(UI_LANG, "side.more", { n });
export const speakerName = (n: number | string) => ht(UI_LANG, "flow.speaker", { n });
export const aiPaused = (why: "cap" | "down" | "net") => ht(UI_LANG, "ai.paused", { why: ht(UI_LANG, `ai.paused.${why}`) });
export const checkNumberSay = (said: string, ref: string) => ht(UI_LANG, "moment.check", { said, ref });
export const checkNumberWhy = () => ht(UI_LANG, "moment.check.why");
export const askOffline = () => ht(UI_LANG, "ask.offline");
export const askNoCall = () => ht(UI_LANG, "ask.nocall");
export const askNothing = () => ht(UI_LANG, "ask.nothing");
export const recapEmpty = () => ht(UI_LANG, "recap.empty");
