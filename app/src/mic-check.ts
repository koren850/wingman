// Verdict of the readiness check's microphone test (pure, so it is unit-tested; doctor.ts runs the 5 s capture).
// Exactly 0 (or no audio at all) means macOS blocks the mic. Some signal but low is only a quiet voice (normal speech can peak near 0.017).
// Peak is 0-1 from audio.ts peakOf(); 0.02 is the "ok" line.
export const MIC_OK_PEAK = 0.02;
export type MicVerdict = "fail" | "warn" | "ok";
export function micVerdict(chunks: number, peak: number): MicVerdict {
  if (chunks === 0 || !(peak > 0)) return "fail";
  return peak > MIC_OK_PEAK ? "ok" : "warn";
}
