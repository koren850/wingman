export type UserEdit =
  | { op: "edit"; id: string; text: string }
  | { op: "remove"; id: string }
  | { op: "add"; list: "facts" | "decisions" | "openQuestions" | "commitments" | "mustCover"; text: string };
declare const m: {
  ID_RE: RegExp;
  ADD_LISTS: string[];
  MAX_TEXT: number;
  cleanLine(v: unknown): string;
  validateEdit(raw: unknown): { ok: true; edit: UserEdit } | { ok: false; reason: string };
  SECTION_LIST: Record<string, string>;
};
export = m;
