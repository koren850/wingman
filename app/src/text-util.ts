// Tiny text helpers shared by several modules. Pure, no imports.

/** Escape a string for literal use inside a RegExp. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Number of whitespace-separated words. */
export const wordCount = (t: string): number => t.split(/\s+/).filter(Boolean).length;
