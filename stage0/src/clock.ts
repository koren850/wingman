// Sleep / clock-jump detection for the health tick. Wall time (Date.now) jumps when the Mac sleeps or the clock is set; the monotonic clock
// (performance.now) does not move while a Mac sleeps. Idle time and frame freshness use the monotonic clock; the wall/mono difference tells sleep apart.

export type ClockPoint = { wall: number; mono: number };
/** "sleep": the process did not run for longer than gapMs (lid closed, or frozen). "clock-back": the wall clock went backwards (clock set / NTP). null: normal. */
export function detectGap(prev: ClockPoint, cur: ClockPoint, gapMs: number, tickMs: number): { kind: "sleep" | "clock-back" | null; ms: number } {
  const wall = cur.wall - prev.wall, mono = cur.mono - prev.mono;
  if (wall < -1000) return { kind: "clock-back", ms: -wall };
  if (gapMs <= 0) return { kind: null, ms: 0 };
  const slept = wall - mono;                       // wall time that the monotonic clock did not see (macOS sleep)
  if (slept > gapMs) return { kind: "sleep", ms: Math.round(wall) };
  if (wall > gapMs + tickMs && mono > gapMs + tickMs) return { kind: "sleep", ms: Math.round(wall) };   // a frozen process on a clock that keeps counting
  return { kind: null, ms: 0 };
}
