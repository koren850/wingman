// Guard pieces that belong to no single language: digits, symbols, version words and technical nouns.
// guards.ts uses them next to the per-language patterns in he.ts and en.ts.

export const CURRENCY_CODES = "nis|ils|usd|eur|gbp|dollars?|shekels?|euros?|pounds?|quid|bucks";
/** Technical nouns after a figure ("30 thousand requests"): not a salary. */
export const TECH_NOUN =
  "(?:requests?|users?|tokens?|rows?|records?|lines?|sites?|pages?|documents?|messages?|calls?|tasks?|files?|events?|customers?|visitors?|items?|products?|דפים|משתמשים|בקשות|שורות|אתרים|מסמכים|הודעות|קבצים|לקוחות|מוצרים)";
// A dotted "12.5" is a date unless a whole tool or version word (or a glued "v", as in "TLSv1.3") comes right before it ("python 3.12", "node 20.5") ...
const VERSIONED_THINGS =
  "version|ver|python|node|ios|android|chrome|php|java|windows|macos|react|vue|angular|wordpress|wp|tls|ssl|http|https|ipv|tcp|udp|usb|ssh|oauth|openssl|nginx|apache|mysql|mariadb|postgres|postgresql|docker|laravel|django|rails|ruby|rust|go|typescript|es|css|html|bootstrap|jquery|wpa|bluetooth|wifi|wi-fi|redis|memcached|elasticsearch|mongo|mongodb|sqlite|kafka|kubernetes|k8s|helm|terraform|ansible|ubuntu|debian|centos|alpine|linux|git|npm|pnpm|yarn|webpack|vite|tailwind|svelte|next|nuxt|cuda";
// ... or a unit or technical noun comes right after it ("4.5 years", "2.0 api", "3.5 שעות").
const MEASURE_AFTER =
  "years?|months?|hours?|weeks?|days?|x|%|k\\b|gb|mb|seconds?|handshakes?|protocol|spec|release|update|patch|build|api|sdk|runtime|compiler|kernel|שנ|חודש|שעות|ימים|אחוז";
const DOTTED_DAY_MONTH = new RegExp(
  `(?<!(?:(?<![a-z\\d])(?:${VERSIONED_THINGS})|v)\\s?)(?<![\\d.,])(?:0?[1-9]|[12]\\d|3[01])\\.(?:0?[1-9]|1[0-2])(?![\\d.,])(?!\\s?(?:${MEASURE_AFTER}))`,
  "i",
);

/** Price patterns with no language of their own (currency symbols, amounts with a currency word). */
export const SHARED_PRICE: RegExp[] = [/[₪$€£]\s?\d/, new RegExp(`\\d[\\d,.]*\\s?(₪|ש"?ח|ש''ח|שקל|שקלים|דולר|יורו|${CURRENCY_CODES})(?![\\p{L}])`, "iu")];
/** Date patterns made of digits only: 5/11, 12.5.2026, "12.5" (unless a version), clock times. */
export const SHARED_DATE: RegExp[] = [
  // numeric dates: 5/11, 5/11/26, 12.5.2026, and a two-part dotted "12.5" unless it is a version or a measure ("version 2.0", "4.5 years")
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
  /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/,
  DOTTED_DAY_MONTH,
  /(?<![\d:.])\d{1,2}:\d{2}(?![\d:])/,
];

/** Tools, clouds and skills an interview answer must not claim unless the user's own profile, cards or plan name them. Names are not translated. */
export const CLAIMABLE = [
  "OpenAI",
  "GPT",
  "ChatGPT",
  "Gemini",
  "Llama",
  "Mistral",
  "LangChain",
  "LlamaIndex",
  "Pinecone",
  "Weaviate",
  "Chroma",
  "pgvector",
  "AWS",
  "GCP",
  "Google Cloud",
  "Azure",
  "Kubernetes",
  "K8s",
  "Terraform",
  "Kafka",
  "Spark",
  "Airflow",
  "fine-tuning",
  "fine-tune",
  "Java",
  "C#",
  ".NET",
  "Go",
  "Golang",
  "Rust",
  "Angular",
  "Vue",
  "Django",
  "FastAPI",
  "Flask",
  "Spring",
  "PyTorch",
  "TensorFlow",
  "Snowflake",
  "Databricks",
];
