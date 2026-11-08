// What a model call without a memory loop behind it reads: the paused-AI and legacy question path (engine/question.ts askModel).
// It gets the call memory (what the call has learned so far, session.json) rendered under a budget, and a plain tail of the last lines.
// The tail is cut by size, not by a fixed line count: many short lines fit, a few long ones do too. No model call, no word list. Pure.
import { estimateTokens } from "../context/budget.ts";
import { renderMemory } from "../session/render.ts";
import { isEmptyMemory, type SessionMemory } from "../session/types.ts";

export const ASK_MEMORY_TOKENS = 700;
export const ASK_TAIL_TOKENS = 450;
export const ASK_TAIL_MAX_LINES = 30;

/** The newest lines that fit `maxTokens`, oldest first, one per line. At least the newest line is always kept (cut if it alone is too long). */
export function localTail(lines: readonly string[], maxTokens = ASK_TAIL_TOKENS, maxLines = ASK_TAIL_MAX_LINES): string {
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const t = estimateTokens(lines[i]) + 1;
    if (out.length && used + t > maxTokens) break;
    out.unshift(lines[i]);
    used += t;
  }
  const text = out.join("\n");
  return out.length === 1 && used > maxTokens ? text.slice(-maxTokens * 3) : text;
}

/** The call memory as a short text for the question prompt, or "" when the call has not learned anything yet. */
export function memoryForAsk(mem: SessionMemory, budgetTokens = ASK_MEMORY_TOKENS): string {
  return isEmptyMemory(mem) ? "" : renderMemory(mem, budgetTokens);
}
