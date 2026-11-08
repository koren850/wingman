// Token estimate factors. The estimate of a prompt is  ascii chars / asciiCharsPerToken + hebrew chars * hebrewTokensPerChar + other chars * otherTokensPerChar.
// The defaults below are the values the estimate has always used (3.5 chars per ASCII token, 0.6 token for every other character): they are NOT fitted
// to real calls yet (`fitted: false`). `scripts/calibrate-tokens.ts` fits the three numbers from saved usage rows (the provider's input_tokens against the
// character counts that the context record keeps in `chars`) and prints a new table to commit here. Tests use fixture rows, never a live call.
// The fit is least squares on the three counts; a script that is missing from the rows keeps its default. Pure.

export type Calibration = {
  asciiCharsPerToken: number;
  hebrewTokensPerChar: number;
  otherTokensPerChar: number;
  /** true only for numbers that were fitted from real usage rows */
  fitted: boolean;
};
export const DEFAULT_CALIBRATION: Calibration = { asciiCharsPerToken: 3.5, hebrewTokensPerChar: 0.6, otherTokensPerChar: 0.6, fitted: false };

let current: Calibration = DEFAULT_CALIBRATION;
export const getCalibration = (): Calibration => current;
/** Test hook and the way to apply a fitted table. Undefined restores the defaults. */
export function setCalibration(c: Calibration | undefined): void {
  current = c ?? DEFAULT_CALIBRATION;
}

export type CharCounts = { ascii: number; hebrew: number; other: number };
/** Characters of a text by script class: ASCII, Hebrew block (U+0590 to U+05FF), everything else. */
export function charCounts(s: string): CharCounts {
  const c: CharCounts = { ascii: 0, hebrew: 0, other: 0 };
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 128) c.ascii++;
    else if (code >= 0x0590 && code <= 0x05ff) c.hebrew++;
    else c.other++;
  }
  return c;
}
export const addCounts = (a: CharCounts, b: CharCounts): CharCounts => ({ ascii: a.ascii + b.ascii, hebrew: a.hebrew + b.hebrew, other: a.other + b.other });

/** Estimated tokens for character counts, with the given calibration (the current one by default). */
export function estimateFromCounts(c: CharCounts, cal: Calibration = current): number {
  // equal factors are added up first, so the default gives exactly the old number
  const rest =
    cal.hebrewTokensPerChar === cal.otherTokensPerChar
      ? (c.hebrew + c.other) * cal.hebrewTokensPerChar
      : c.hebrew * cal.hebrewTokensPerChar + c.other * cal.otherTokensPerChar;
  return Math.ceil(c.ascii / cal.asciiCharsPerToken + rest);
}

export type CalSample = { chars: CharCounts; actual: number };

/** Solves a 3x3 system by Gaussian elimination with partial pivoting. Undefined when it is singular. */
function solve3(a: number[][], b: number[]): number[] | undefined {
  const m = a.map((r, i) => [...r, b[i]]);
  for (let col = 0; col < 3; col++) {
    let p = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[p][col])) p = r;
    if (Math.abs(m[p][col]) < 1e-9) return undefined;
    [m[col], m[p]] = [m[p], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let k = col; k < 4; k++) m[r][k] -= f * m[col][k];
    }
  }
  return [0, 1, 2].map((i) => m[i][3] / m[i][i]);
}

/**
 * Fits the three factors from samples. Needs 8 samples. A class that appears in fewer than a fifth of the samples keeps its default (too little data),
 * and the fit is refused (undefined) when a factor comes out zero or negative, or when it is further than 4x from the default.
 */
export function fitCalibration(samples: readonly CalSample[], base: Calibration = DEFAULT_CALIBRATION): Calibration | undefined {
  const ok = samples.filter((s) => s.actual > 0 && s.chars.ascii + s.chars.hebrew + s.chars.other > 0);
  if (ok.length < 8) return undefined;
  const share = (k: keyof CharCounts) => ok.filter((s) => s.chars[k] > 0).length / ok.length;
  const use = { ascii: share("ascii") >= 0.2, hebrew: share("hebrew") >= 0.2, other: share("other") >= 0.2 };
  // Classes without enough data are priced with the default and taken off the actual count, so the others are fitted on what is left.
  const rest = (s: CalSample) =>
    s.actual -
    (use.ascii ? 0 : s.chars.ascii / base.asciiCharsPerToken) -
    (use.hebrew ? 0 : s.chars.hebrew * base.hebrewTokensPerChar) -
    (use.other ? 0 : s.chars.other * base.otherTokensPerChar);
  const x = (s: CalSample): number[] => [use.ascii ? s.chars.ascii : 0, use.hebrew ? s.chars.hebrew : 0, use.other ? s.chars.other : 0];
  // Normal equations. Unused columns get 1 on the diagonal so the system stays solvable.
  const A = [0, 1, 2].map(() => [0, 0, 0]);
  const B = [0, 0, 0];
  for (const s of ok) {
    const v = x(s),
      y = rest(s);
    for (let i = 0; i < 3; i++) {
      B[i] += v[i] * y;
      for (let j = 0; j < 3; j++) A[i][j] += v[i] * v[j];
    }
  }
  [use.ascii, use.hebrew, use.other].forEach((u, i) => {
    if (!u) A[i][i] = 1;
  });
  const sol = solve3(A, B);
  if (!sol) return undefined;
  const [a, h, o] = [
    use.ascii ? sol[0] : 1 / base.asciiCharsPerToken,
    use.hebrew ? sol[1] : base.hebrewTokensPerChar,
    use.other ? sol[2] : base.otherTokensPerChar,
  ];
  const within = (v: number, d: number) => v > 0 && v < d * 4 && v > d / 4;
  if (!within(a, 1 / base.asciiCharsPerToken) || !within(h, base.hebrewTokensPerChar) || !within(o, base.otherTokensPerChar)) return undefined;
  return {
    asciiCharsPerToken: Math.round((1 / a) * 100) / 100,
    hebrewTokensPerChar: Math.round(h * 1000) / 1000,
    otherTokensPerChar: Math.round(o * 1000) / 1000,
    fitted: true,
  };
}

/** Mean of (estimate - actual) / actual over the samples, in percent, with a calibration. Positive = the estimate is too high. */
export function meanDriftPct(samples: readonly CalSample[], cal: Calibration): number | undefined {
  const ok = samples.filter((s) => s.actual > 0);
  if (!ok.length) return undefined;
  const sum = ok.reduce((a, s) => a + (estimateFromCounts(s.chars, cal) - s.actual) / s.actual, 0);
  return Math.round((sum / ok.length) * 1000) / 10;
}

/** Samples out of usage rows: rows with the context record's `chars` and the provider's `input_tokens`. */
export function samplesFromRows(rows: readonly Record<string, unknown>[]): CalSample[] {
  const out: CalSample[] = [];
  for (const r of rows) {
    const chars = (r.ctx as { chars?: Partial<CharCounts> } | undefined)?.chars;
    const actual = Number(r.input_tokens);
    if (!chars || !(actual > 0)) continue;
    const c = { ascii: Number(chars.ascii) || 0, hebrew: Number(chars.hebrew) || 0, other: Number(chars.other) || 0 };
    out.push({ chars: c, actual });
  }
  return out;
}

/** The calibration table as text lines: one row per class with the default and the fitted number, and the drift before and after. */
export function formatCalibration(samples: readonly CalSample[], fit: Calibration | undefined): string[] {
  const d = DEFAULT_CALIBRATION;
  const lines = [`samples: ${samples.length}`];
  lines.push(`default: ascii ${d.asciiCharsPerToken} chars/token, hebrew ${d.hebrewTokensPerChar} token/char, other ${d.otherTokensPerChar} token/char`);
  const before = meanDriftPct(samples, d);
  if (!fit)
    return [...lines, `drift with the default: ${before === undefined ? "n/a" : before + "%"}`, "not enough data to fit (needs 8 rows with character counts)"];
  const after = meanDriftPct(samples, fit);
  return [
    ...lines,
    `fitted:  ascii ${fit.asciiCharsPerToken} chars/token, hebrew ${fit.hebrewTokensPerChar} token/char, other ${fit.otherTokensPerChar} token/char`,
    `drift with the default: ${before}%  with the fitted numbers: ${after}%`,
  ];
}
