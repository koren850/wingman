// "The other side is not heard" has three owners: the system-audio source is down, the tap watchdog saw no frames, or the source is switched off.
// Each owner sets and clears only its own reason; the supervisor gets `themDead` = any reason is set. So one owner coming back cannot clear another's.

export function themDeadFlag(apply: (dead: boolean) => void) {
  const reasons = new Set<"sys" | "tap" | "off">();
  return (owner: "sys" | "tap" | "off", on: boolean) => {
    const before = reasons.size > 0;
    if (on) reasons.add(owner);
    else reasons.delete(owner);
    const now = reasons.size > 0;
    if (now !== before) apply(now);
  };
}
