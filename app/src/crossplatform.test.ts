// Windows and Linux logic, tested on any machine: the platform is a parameter, never a mocked global.
// Covers the data folder, the named-pipe names, how local tools are spawned, the control endpoint, plus the security leftovers
// (link and phone neutralising in the follow-up email, the attachment extension allow-list, the Electron permission lockdown).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, writeFileSync, chmodSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import paths from "../shared/paths.cjs";
import pipe from "../shared/pipe.cjs";
import bin from "../shared/bin.cjs";
import permissions from "../shared/permissions.cjs";
import { ROOT, securePerms } from "./env.ts";
import { ownSocket } from "./cli/client.ts";
import { guardEmail, neutralizeLinks } from "./summary.ts";

const req = createRequire(import.meta.url);
const tmp = () => mkdtempSync(join(tmpdir(), "wm-xp-"));

// ---- data folder ----
test("data folder: macOS unchanged, Windows %APPDATA%\\Wingman, Linux XDG or ~/.local/share/wingman, override wins", () => {
  assert.equal(paths.dataDir({}, "/Users/x", "darwin"), "/Users/x/Library/Application Support/Wingman");
  assert.equal(paths.dataDir({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "C:\\Users\\x", "win32"), "C:\\Users\\x\\AppData\\Roaming\\Wingman");
  assert.equal(paths.dataDir({}, "C:\\Users\\x", "win32"), "C:\\Users\\x\\AppData\\Roaming\\Wingman", "no APPDATA: the standard Roaming folder");
  assert.equal(paths.dataDir({ XDG_DATA_HOME: "/data/xdg" }, "/home/x", "linux"), "/data/xdg/wingman");
  assert.equal(paths.dataDir({}, "/home/x", "linux"), "/home/x/.local/share/wingman");
  assert.equal(
    paths.dataDir({ XDG_DATA_HOME: "relative/dir" }, "/home/x", "linux"),
    "/home/x/.local/share/wingman",
    "a relative XDG_DATA_HOME is ignored (spec)",
  );
  assert.equal(paths.dataDir({ WINGMAN_DATA_DIR: "/tmp/w" }, "/home/x", "win32").replace(/\\/g, "/").endsWith("/tmp/w"), true);
  assert.equal(paths.callsDir({}, "/home/x", "linux"), "/home/x/.local/share/wingman/calls", "calls follows the data folder");
});

// ---- named pipes ----
test("pipe names: \\\\.\\pipe\\wingman-<user>-<name>, reduced to safe characters; Unix keeps the socket file", () => {
  assert.equal(pipe.pipeName("control", "alex"), "\\\\.\\pipe\\wingman-alex-control");
  assert.equal(pipe.pipeName("rows-1", "A B\\c"), "\\\\.\\pipe\\wingman-A_B_c-rows-1");
  assert.equal(pipe.pipeName("../x", "u"), "\\\\.\\pipe\\wingman-u-___x", "no path characters get through");
  assert.equal(pipe.usesPipes("win32"), true);
  assert.equal(pipe.usesPipes("darwin"), false);
  assert.equal(pipe.usesPipes("linux"), false);
  assert.equal(pipe.endpoint("control", "/home/x/c.sock", "linux"), "/home/x/c.sock");
  assert.equal(pipe.endpoint("control", "/home/x/c.sock", "win32", "alex"), "\\\\.\\pipe\\wingman-alex-control");
});

test("control endpoint: Unix path on macOS/Linux, a per-user named pipe on Windows; a test socket path maps to its own pipe", () => {
  const cs = req("../tray/control-socket.cjs");
  const os = { homedir: () => "/home/x" };
  assert.equal(cs.socketPath({}, os, "linux"), "/home/x/.config/wingman/run/control.sock");
  assert.equal(cs.socketPath({}, os, "darwin"), "/home/x/.config/wingman/run/control.sock");
  assert.match(cs.socketPath({}, os, "win32"), /^\\\\\.\\pipe\\wingman-.+-control$/);
  const a = cs.socketPath({ WINGMAN_CONTROL_SOCKET: "/t/a.sock" }, os, "win32"),
    b = cs.socketPath({ WINGMAN_CONTROL_SOCKET: "/t/b.sock" }, os, "win32");
  assert.match(a, /^\\\\\.\\pipe\\wingman-.+-control-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
  assert.equal(a, cs.endpointFor("/t/a.sock", "win32"), "client and server derive the same pipe");
  assert.equal(ownSocket(a, "win32"), true, "a pipe name needs no file check");
  assert.equal(ownSocket("C:\\temp\\fake.sock", "win32"), false, "a file path is not accepted as a Windows endpoint");
});

test("control server on Windows: listens on the pipe and never touches folders, umask or chmod", async () => {
  const cs = req("../tray/control-socket.cjs");
  const boom = new Proxy(
    {},
    {
      get: (_t, k) => () => {
        throw new Error("fs." + String(k) + " must not be called for a pipe");
      },
    },
  );
  let listened = "";
  const net = {
    createServer: () => ({
      on() {},
      once() {},
      listen: (p: string, cb: () => void) => {
        listened = p;
        cb();
      },
      close: (cb: () => void) => cb(),
    }),
  };
  const srv = cs.createControlServer({ platform: "win32", fs: boom, net, controller: {}, lib: {}, plans: {}, socketPath: "/t/win.sock" });
  assert.equal(await srv.start(), cs.endpointFor("/t/win.sock", "win32"));
  assert.match(listened, /^\\\\\.\\pipe\\/);
  await srv.stop();
});

// ---- how local tools are spawned ----
test("bin helper: .bin/<tool> on macOS and Linux; node + the tsx CLI, or the real electron.exe, on Windows (no .cmd shim)", () => {
  const root = "/r";
  assert.deepEqual(bin.binCommand("tsx", ["a.ts"], root, { platform: "darwin" }), { cmd: "/r/node_modules/.bin/tsx", args: ["a.ts"] });
  assert.deepEqual(bin.binCommand("electron", ["m.cjs"], root, { platform: "linux" }), { cmd: "/r/node_modules/.bin/electron", args: ["m.cjs"] });
  const w = bin.binCommand("tsx", ["src\\run.ts", "--file", "x.wav"], "C:\\w\\app", { platform: "win32", execPath: "C:\\node\\node.exe" });
  assert.equal(w.cmd, "C:\\node\\node.exe");
  assert.deepEqual(w.args, ["C:\\w\\app\\node_modules\\tsx\\dist\\cli.mjs", "src\\run.ts", "--file", "x.wav"]);
  const fs = { readFileSync: () => "electron.exe" };
  const e = bin.binCommand("electron", ["overlay\\main.cjs"], "C:\\w\\app", { platform: "win32", fs, env: {} });
  assert.equal(e.cmd, "C:\\w\\app\\node_modules\\electron\\dist\\electron.exe");
  assert.deepEqual(e.args, ["overlay\\main.cjs"]);
  const e2 = bin.binCommand("electron", [], "C:\\w", {
    platform: "win32",
    fs: {
      readFileSync: () => {
        throw new Error("none");
      },
    },
    env: { ELECTRON_OVERRIDE_DIST_PATH: "D:\\dist" },
  });
  assert.equal(e2.cmd, "D:\\dist\\electron.exe");
  assert.ok(!/\.cmd$/i.test(w.cmd) && !/\.cmd$/i.test(e.cmd), "a .cmd cannot be spawned without a shell");
});

test("bin helper: the tsx CLI entry it points to really exists in node_modules", () => {
  assert.ok(existsSync(bin.tsxCli(ROOT)), bin.tsxCli(ROOT));
});

// ---- file modes ----
test(
  "keys file mode check is skipped on Windows (no POSIX modes) and still fixes the mode elsewhere",
  { skip: process.platform === "win32" && "POSIX modes" },
  () => {
    const f = join(tmp(), "keys.env");
    writeFileSync(f, "A=1\n");
    chmodSync(f, 0o666);
    assert.equal(securePerms(f, "win32"), "ok");
    assert.equal(statSync(f).mode & 0o777, 0o666, "Windows branch leaves the file alone");
    assert.equal(securePerms(f, "darwin"), "fixed");
    assert.equal(statSync(f).mode & 0o777, 0o600);
  },
);

// ---- M4: links and phone numbers the user did not write ----
test("follow-up email: a link or phone number that is not in the user's own notes becomes a placeholder; the user's own stay", () => {
  const notes = "האתר שלנו: https://acme.example/support\nהטלפון שלי 050-123-4567";
  const email =
    "שלום,\nכדי לאשר היכנס ל https://evil.example/confirm?id=7 או חייג 03-555-0199.\nהתמיכה שלנו ב https://acme.example/support וגם 050-123-4567.\nכתבי ל dana@acme.co.il\nשלך";
  const g = guardEmail(email, notes);
  assert.doesNotMatch(g.text, /evil\.example|555-0199/);
  assert.match(g.text, /\[להשלים: קישור\]/);
  assert.match(g.text, /\[להשלים: טלפון\]/);
  assert.match(g.text, /https:\/\/acme\.example\/support/);
  assert.match(g.text, /050-123-4567/);
  assert.match(g.text, /dana@acme\.co\.il/, "email addresses are not touched");
  assert.ok(g.rules.includes("url") && g.rules.includes("phone"));
  assert.equal(g.text.split("\n").length, email.split("\n").length);
});

test("neutralizeLinks: bare domains and www links, trailing punctuation kept, short numbers and prices left alone, ISO dates are not phones", () => {
  assert.equal(neutralizeLinks("Visit www.evil.com.", "").text, "Visit [להשלים: קישור].");
  assert.equal(neutralizeLinks("go to evil.example/x now", "").text, "go to [להשלים: קישור] now");
  assert.equal(neutralizeLinks("call +972 3 555 0199 today", "").text, "call [להשלים: טלפון] today");
  assert.equal(neutralizeLinks("call 972355550199", "tel 03-555-0199").kinds.length, 1, "a different number is not trusted");
  assert.equal(neutralizeLinks("call +972-3-555-0199", "03-555-0199 +972-3-555-0199").kinds.length, 0);
  assert.equal(neutralizeLinks("3 items, 1500 total, 2026-03-12", "").kinds.length, 0);
  assert.equal(neutralizeLinks("the file report.pdf", "").kinds.length, 0, "a file name is not a link");
  assert.equal(neutralizeLinks("Visit https://acme.example/x.", "see acme.example/x").text, "Visit https://acme.example/x.", "known without the scheme");
});

// ---- L3: attachments by extension allow-list ----
test("attachments from the command line: only .txt, .md and .pdf; the secret folders and names stay refused first", () => {
  const A = req("../tray/attachments.cjs");
  const home = tmp();
  for (const f of ["a.txt", "b.md", "c.pdf", "d.json", "e.yaml", "f.yml", "g.png", "h.sh", "history", "i.TXT"]) writeFileSync(join(home, f), "text");
  mkdirSync(join(home, ".kube"));
  writeFileSync(join(home, ".kube", "x.txt"), "token");
  mkdirSync(join(home, "AppData", "Roaming", "Microsoft", "Credentials"), { recursive: true });
  writeFileSync(join(home, "AppData", "Roaming", "Microsoft", "Credentials", "c.txt"), "cred");
  const code = (f: string) => {
    try {
      A.readSourceFile(join(home, f), { home });
      return "ok";
    } catch (e: any) {
      return e.code;
    }
  };
  for (const f of ["a.txt", "b.md", "c.pdf", "i.TXT"]) assert.equal(code(f), "ok", f);
  for (const f of ["d.json", "e.yaml", "f.yml", "g.png", "h.sh", "history"]) assert.equal(code(f), "type", f);
  assert.equal(code(".kube/x.txt"), "secret");
  assert.equal(code("AppData/Roaming/Microsoft/Credentials/c.txt"), "secret");
});

// ---- L2: Electron permission lockdown ----
function fakeSession() {
  const s: any = { calls: {} };
  s.setPermissionRequestHandler = (h: any) => {
    s.request = h;
  };
  s.setPermissionCheckHandler = (h: any) => {
    s.check = h;
  };
  s.setDevicePermissionHandler = (h: any) => {
    s.device = h;
  };
  return s;
}
test("permissions: every request, check and device is refused; an explicit allow-list is the only exception", () => {
  const s = fakeSession();
  permissions.denyPermissions(s);
  for (const p of ["media", "geolocation", "notifications", "clipboard-read", "display-capture", "midi", "openExternal"]) {
    let got: boolean | undefined;
    s.request({}, p, (v: boolean) => {
      got = v;
    });
    assert.equal(got, false, p);
    assert.equal(s.check({}, p), false, p);
  }
  assert.equal(s.device({}), false);
  const t = fakeSession();
  permissions.denyPermissions(t, ["media"]);
  let m: boolean | undefined, g: boolean | undefined;
  t.request({}, "media", (v: boolean) => {
    m = v;
  });
  t.request({}, "geolocation", (v: boolean) => {
    g = v;
  });
  assert.equal(m, true);
  assert.equal(g, false);
});

test("permissions: install() locks the session of every new web contents and blocks webview and redirects", () => {
  const handlers: Record<string, any> = {};
  const app = {
    on: (ev: string, h: any) => {
      handlers[ev] = h;
    },
  };
  permissions.install(app);
  const ses = fakeSession();
  const wcOn: Record<string, any> = {};
  const wc = {
    session: ses,
    on: (ev: string, h: any) => {
      wcOn[ev] = h;
    },
  };
  handlers["web-contents-created"]({}, wc);
  let ok: boolean | undefined;
  ses.request({}, "media", (v: boolean) => {
    ok = v;
  });
  assert.equal(ok, false);
  for (const ev of ["will-attach-webview", "will-redirect"]) {
    let prevented = false;
    wcOn[ev]({
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true, ev);
  }
});

test("every Electron main process installs the permission lockdown", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["tray/main.cjs", "overlay/main.cjs"])
    assert.match(readFileSync(join(ROOT, f), "utf8"), /require\("\.\.\/shared\/permissions\.cjs"\)\.install\(app\)/, f);
});

test("no spawn site builds .bin/tsx or .bin/electron by hand", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const bad: string[] = [];
  for (const d of ["src", "src/cli", "src/engine", "tray", "dashboard", "overlay"])
    for (const f of readdirSync(join(ROOT, d))) {
      if (!/\.(ts|cjs|js)$/.test(f) || /\.test\./.test(f)) continue;
      if (/"\.bin"/.test(readFileSync(join(ROOT, d, f), "utf8"))) bad.push(`${d}/${f}`);
    }
  assert.deepEqual(bad, []);
});
