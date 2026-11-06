// pnpm keys status|set <provider>|remove <provider>|migrate: manage the Deepgram/Anthropic keys in the macOS Keychain.
// Talks to the Keychain directly (src/keychain.ts), not to the tray app. Values are never taken from argv (visible in `ps`)
// and never printed. `set` reads from a hidden TTY prompt.
import { realKeychain, keyStatus, migrateKeysToKeychain, checkKeyFormat, PROVIDERS, ACCOUNTS, scrub, type Keychain, type Provider } from "./keychain.ts";
import { KEYS_FILE } from "./env.ts";
import { loadSettings, expandHome } from "./settings.ts";

/** Reads one line from the TTY without echo. Exported for tests only through the `readSecret` parameter of main(). */
export function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const i = process.stdin;
    if (!i.isTTY) return reject(new Error("set needs an interactive terminal (the key is never read from arguments or pipes)"));
    process.stderr.write(prompt);
    let buf = "";
    i.setRawMode(true);
    i.resume();
    i.setEncoding("utf8");
    const done = (fn: () => void) => {
      i.setRawMode(false);
      i.pause();
      i.removeListener("data", on);
      process.stderr.write("\n");
      fn();
    };
    const on = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") return done(() => resolve(buf));
        if (c === "\u0003") return done(() => reject(new Error("cancelled")));
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else if (c >= " ") buf += c;
      }
    };
    i.on("data", on);
  });
}

/** Runs one subcommand and returns the exit code (0 ok, 1 failed, 2 bad usage). `o` lets tests inject the Keychain, file, prompt and output. */
export async function main(
  argv: string[],
  o: { keychain?: Keychain; keysFile?: string; readSecret?: (p: string) => Promise<string>; out?: (s: string) => void } = {},
): Promise<number> {
  const out = o.out ?? ((s: string) => console.log(s));
  const keychain = o.keychain ?? realKeychain();
  const file = o.keysFile ?? (expandHome(loadSettings({ argv: [], env: {} }).settings.keys.file) || KEYS_FILE);
  const [cmd, prov] = argv;
  const provider = prov as Provider;
  const needProv = () => {
    if (!PROVIDERS.includes(provider)) {
      out(`provider must be one of: ${PROVIDERS.join(", ")}`);
      return false;
    }
    return true;
  };
  if (cmd === "status") {
    const st = keyStatus({ keychain, file });
    for (const p of PROVIDERS) {
      const s = st[p];
      out(
        `${ACCOUNTS[p].padEnd(20)} ${s.source === "missing" ? "missing" : `${{ keychain: "Keychain", file: "file (run: pnpm keys migrate)", env: "environment" }[s.source]} ...${s.last4}`}`,
      );
    }
    return 0;
  }
  if (cmd === "set") {
    if (!needProv()) return 2;
    let v: string;
    try {
      v = await (o.readSecret ?? readHidden)(`Paste the ${ACCOUNTS[provider]} (hidden), then Enter: `);
    } catch (e) {
      out((e as Error).message);
      return 1;
    }
    v = v.trim();
    const bad = checkKeyFormat(provider, v);
    if (bad) {
      out(bad);
      return 1;
    }
    try {
      keychain.set(provider, v);
    } catch (e) {
      out(scrub((e as Error).message, [v]));
      return 1;
    }
    out(`Saved ${ACCOUNTS[provider]} in the Keychain (...${v.slice(-4)}).`);
    return 0;
  }
  if (cmd === "remove") {
    if (!needProv()) return 2;
    out(keychain.remove(provider) ? `Removed ${ACCOUNTS[provider]} from the Keychain.` : `${ACCOUNTS[provider]} was not in the Keychain.`);
    return 0;
  }
  if (cmd === "migrate") {
    let r;
    try {
      r = migrateKeysToKeychain({ keychain, file });
    } catch (e) {
      out((e as Error).message);
      return 1;
    }
    out(`Moved to Keychain: ${r.moved.map((p) => ACCOUNTS[p]).join(", ") || "nothing"}`);
    if (r.alreadyInKeychain.length) out(`Already in Keychain (file line left alone): ${r.alreadyInKeychain.map((p) => ACCOUNTS[p]).join(", ")}`);
    for (const f of r.failed) out(`Not moved: ${ACCOUNTS[f.provider]} (${f.reason})`);
    return r.failed.length ? 1 : 0;
  }
  out("usage: pnpm keys status | set <deepgram|anthropic> | remove <deepgram|anthropic> | migrate");
  return 2;
}

// Run only when executed directly, not when imported by tests.
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c));
