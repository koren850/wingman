// Clean-up of speech-to-text finals that smart formatting got wrong in Hebrew. Pure text in, text out. It runs on every final, before the engine reads the line.
//   - "שישים אלף" comes back as "60 1000": a small number and the number 1000 / 1000000 next to each other are a product: 60000.
//   - A weekday is written as "יום 4º" (the ordinal sign): the day name. Any other ordinal sign is dropped and the digit stays ("שאלה 1º" -> "שאלה 1").
// No word list for numbers: only the digits and the ordinal sign are read. English text has none of these shapes, so it passes unchanged.

const WEEKDAYS: Record<string, string> = { "1": "ראשון", "2": "שני", "3": "שלישי", "4": "רביעי", "5": "חמישי", "6": "שישי", "7": "שבת" };
const SCALE = /(?<![\d.,])(\d{1,3})\s+(1000|1,000|1000000|1,000,000)(?![\d.,])/g;
const ORDINAL = /(\d+)\s?[º°ᵒ](?![\p{L}\d])/gu;
const HEBREW = /[֐-׿]/;

export function cleanSttText(text: string): string {
  if (!text || !HEBREW.test(text)) return text;
  return text
    .replace(SCALE, (_m, small: string, scale: string) => String(Number(small) * Number(scale.replace(/,/g, ""))))
    .replace(/יום\s+([1-7])\s?[º°ᵒ](?![\p{L}\d])/gu, (_m, d: string) => `יום ${WEEKDAYS[d]}`)
    .replace(ORDINAL, "$1");
}
