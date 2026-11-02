// Is a call app running? Decides how loud the "I only hear you" state is: a red alarm only when a call app is open
// (then silence from the other side is a real problem), a calm hint otherwise (Dan is testing or thinking aloud).
import { execFile } from "node:child_process";

/** Process names (lines of `ps -axo comm`) that mean a call is probably in progress or about to start. */
const CALL_APPS: [string, RegExp][] = [
  ["Zoom", /\/zoom\.us(\.app)?\/|\/zoom\.us$|CptHost/i],
  ["Teams", /Microsoft Teams|\/MSTeams|\/Teams\.app/i],
  ["FaceTime", /\/FaceTime\.app\//i],
  ["Webex", /\/Webex|Cisco Webex/i],
  ["Skype", /\/Skype\.app\//i],
  ["Discord", /\/Discord\.app\/Contents\/MacOS\/Discord$/i],
  ["Slack huddle", /Slack Helper.*(huddle|call)/i],
  ["GoToMeeting", /GoToMeeting|GoTo Meeting/i],
];

/** Pure: which call app does this process list show? undefined = none. */
export function callAppIn(psOutput: string): string | undefined {
  for (const line of String(psOutput).split("\n")) for (const [name, re] of CALL_APPS) if (re.test(line)) return name;
  return undefined;
}

/** WINGMAN_CALL_APP=zoom|none forces the answer (tests, QA, practice). Otherwise reads the process list; any failure = unknown (undefined). */
export function callAppRunning(timeoutMs = 3000): Promise<string | undefined> {
  const forced = process.env.WINGMAN_CALL_APP;
  if (forced !== undefined && forced !== "") return Promise.resolve(forced === "none" || forced === "0" ? undefined : forced);
  return new Promise((res) => {
    if (process.platform !== "darwin") return res(undefined);
    execFile("ps", ["-axo", "comm"], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, out) => res(err ? undefined : callAppIn(out)));
  });
}
