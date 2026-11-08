// The `wingman` CLI and the app's control socket. Offline: temp socket, temp calls/briefs/settings dirs, a fake child process
// (or the scripted engine in file mode), invented data only. No app, no mic, no network, no window.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync, symlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { writeWav } from "./audio.ts";
import { main } from "./cli/index.ts";
import { HELP } from "./cli/help.ts";
import { applyPatch } from "./session/patch.ts";
import { saveMemory } from "./session/store.ts";
import { emptyMemory } from "./session/types.ts";
import { assertMode, tsx, POSIX, SYMLINK, ENGINE_CHILD } from "./test-platform.ts";

const req = createRequire(import.meta.url);
const { createController } = req("../tray/controller.cjs");
const { createControlServer } = req("../tray/control-socket.cjs");
const trayLib = req("../tray/lib.cjs");
const { createPlanStore } = req("../tray/plans.cjs");

const tmp = (n: string) => mkdtempSync(join(tmpdir(), `wm-cli-${n}-`));

function fakeSpawn() {
  const spawned: any[] = [];
  const spawnFn = (_cmd: string, args: string[], opts: any) => {
    const c: any = new EventEmitter();
    c.pid = 4242;
    c.args = args;
    c.opts = opts;
    c.written = [] as string[];
    c.stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: (s: string) => {
        c.written.push(s);
        return true;
      },
    });
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => {};
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c);
    return c;
  };
  return { spawnFn, spawned };
}

async function rig(opts: { now?: () => number; spawn?: any; callsDir?: string; askCliStart?: boolean; answer?: boolean | (() => Promise<boolean>) } = {}) {
  const asked = { start: 0, del: 0, consent: 0 };
  const answer = async () => (typeof opts.answer === "function" ? opts.answer() : opts.answer !== false);
  const dir = tmp("rig");
  const sock = join(dir, "run", "control.sock");
  const logs: string[] = [];
  let clock = 5_000_000; // each rate-limit check advances 2 s unless a test passes its own clock
  const f = fakeSpawn();
  const plans = createPlanStore({ dir: join(dir, "briefs"), pdftotext: "" }); // the same folder the CLI reads (WINGMAN_BRIEFS_DIR below)
  const ctl = createController({ spawn: opts.spawn ?? f.spawnFn, root: ROOT, tmpDir: dir, setTimeout: () => 0, kill: () => {}, logPath: "", plans });
  const env = {
    ...process.env,
    HOME: dir,
    WINGMAN_CONTROL_SOCKET: sock,
    WINGMAN_CALLS_DIR: opts.callsDir ?? join(dir, "calls"),
    WINGMAN_BRIEFS_DIR: join(dir, "briefs"),
    WINGMAN_USER_SETTINGS: join(dir, "settings.yaml"),
  };
  mkdirSync(opts.callsDir ?? join(dir, "calls"), { recursive: true });
  const server = createControlServer({
    controller: ctl,
    lib: trayLib,
    plans,
    socketPath: sock,
    log: (s: string) => logs.push(s),
    now: opts.now ?? (() => (clock += 2000)),
    info: () => ({ pid: 1, version: "t" }),
    askCliStart: async () => opts.askCliStart !== false,
    confirm: {
      start: async () => {
        asked.start++;
        return answer();
      },
      consent: async () => {
        asked.consent++;
        return answer();
      },
      stopDelete: async () => {
        asked.del++;
        return answer();
      },
    },
  });
  await server.start();
  const run = async (...argv: string[]) => {
    let out = "",
      err = "";
    const code = await main(argv, {
      env,
      home: dir,
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      sleep: (ms: number) => new Promise((res) => setTimeout(res, Math.min(ms, 30))),
      stdin: async () => "from stdin",
    });
    return {
      code,
      out,
      err,
      json: (() => {
        try {
          return JSON.parse(out.trim().split("\n")[0]);
        } catch {
          return undefined;
        }
      })(),
    };
  };
  const raw = (line: string) =>
    new Promise<any>((res) => {
      const s = net.createConnection(req("../tray/control-socket.cjs").endpointFor(sock));
      let b = "";
      s.on("connect", () => s.write(line));
      s.on("data", (d) => (b += d));
      s.on("close", () => res(JSON.parse(b)));
    });
  return {
    dir,
    sock,
    ctl,
    plans,
    server,
    logs,
    f,
    asked,
    env,
    run,
    raw,
    done: async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("socket: owner-only permissions (folder 700, socket 600)", POSIX, async () => {
  const r = await rig();
  try {
    assertMode(r.sock, 0o600);
    assertMode(join(r.dir, "run"), 0o700);
  } finally {
    await r.done();
  }
});

test("socket: only the fixed allowlist, strict argument schema, no arbitrary exec", async () => {
  const r = await rig();
  try {
    assert.equal((await r.raw('{"v":1,"cmd":"ping"}\n')).ok, true);
    for (const cmd of ["exec", "shell", "__proto__", "constructor", "toString", "keys", "settings", "purge"])
      assert.equal((await r.raw(JSON.stringify({ v: 1, cmd }) + "\n")).code, "unknown_command", cmd);
    assert.equal((await r.raw("not json\n")).code, "bad_request");
    assert.equal((await r.raw('{"v":2,"cmd":"ping"}\n')).code, "bad_request");
    assert.equal((await r.raw('{"v":1,"cmd":"ping","extra":1}\n')).code, "bad_request");
    assert.equal((await r.raw('{"v":1,"cmd":"ping","args":{"x":1}}\n')).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"note","args":{}}\n')).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"note","args":{"text":5}}\n')).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"note","args":{"text":"a","cmd":"rm"}}\n')).code, "bad_args");
    assert.equal((await r.raw(JSON.stringify({ v: 1, cmd: "note", args: { text: "x".repeat(2001) } }) + "\n")).code, "bad_args");
    for (const args of [{}, { spk: 0 }, { spk: 21 }, { spk: 1.5 }, { spk: "2" }, { spk: 2, name: 5 }, { spk: 2, name: "x".repeat(41) }, { spk: 2, extra: 1 }])
      assert.equal((await r.raw(JSON.stringify({ v: 1, cmd: "speaker", args }) + "\n")).code, "bad_args", JSON.stringify(args));
    assert.equal((await r.raw('{"v":1,"cmd":"speaker","args":{"spk":2,"name":"Dana"}}\n')).code, "refused", "no call is running");
    assert.equal((await r.raw(JSON.stringify({ v: 1, cmd: "ping", args: {}, pad: "x".repeat(20000) }) + "\n")).code, "too_large");
    assert.equal((await r.raw('{"v":1,"cmd":"stop_delete","args":{"confirm":false}}\n')).code, "refused");
  } finally {
    await r.done();
  }
});

test("socket: start/stop drive the app's controller (one call, no second engine), ask reaches the call as 'ask <text>'", async () => {
  const r = await rig();
  try {
    const a = await r.run("status", "--json");
    assert.equal(a.code, 0);
    assert.equal(a.json.app.running, true);
    assert.equal(a.json.call.phase, "idle");
    const s = await r.run("start", "--json", "--no-wait");
    assert.equal(s.code, 0, s.out + s.err);
    assert.equal(r.f.spawned.length, 1);
    assert.ok(r.f.spawned[0].args[process.platform === "win32" ? 1 : 0].endsWith("call.ts")); // Windows: node + tsx CLI first
    assert.equal(r.f.spawned[0].opts.env.WINGMAN_CONTROL, "1");
    const again = await r.run("start", "--json", "--no-wait");
    assert.equal(again.code, 4, "second start refused");
    assert.equal(r.f.spawned.length, 1, "never a second engine");
    const c = r.f.spawned[0];
    c.say("waiting", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    assert.equal((await r.run("status", "--json")).json.call.phase, "waiting");
    assert.equal((await r.run("ask", "מה המחיר", "--json")).code, 4, "ask needs a live call");
    assert.equal((await r.run("consent", "--json")).code, 6, "consent needs --yes");
    assert.equal((await r.run("consent", "--yes", "--json")).code, 0);
    assert.deepEqual(c.written, ["consent\n"]);
    assert.equal(r.asked.consent, 1, "the socket consent asks in the app first");
    c.say("consented");
    const q = await r.run("ask", "what", "is", "the", "price?", "--no-wait", "--json");
    assert.equal(q.code, 0, q.out);
    assert.equal(typeof q.json.engineSupportsAsk, "boolean");
    assert.equal((await r.run("note", "she is the owner", "--json")).code, 0);
    assert.equal((await r.run("note", "x".repeat(301), "--json")).code, 2);
    assert.equal((await r.run("ask", "-", "--no-wait", "--json")).code, 0, "stdin text");
    assert.equal((await r.run("ask", "--listen", "--json")).code, 0);
    assert.deepEqual(c.written.slice(1), ["ask what is the price?\n", "note she is the owner\n", "ask from stdin\n", "ask\n"]);
    assert.equal((await r.run("speaker", "2", "Dana", "Levi", "--json")).code, 0);
    assert.equal((await r.run("speaker", "2", "--clear", "--json")).code, 0);
    for (const bad of [
      ["speaker"],
      ["speaker", "2"],
      ["speaker", "0", "Dana"],
      ["speaker", "21", "Dana"],
      ["speaker", "x", "Dana"],
      ["speaker", "2", "Dana", "--clear"],
      ["speaker", "2", "x".repeat(41)],
    ])
      assert.equal((await r.run(...bad, "--json")).code, 2, bad.join(" "));
    assert.deepEqual(c.written.slice(5), ["speaker 2 Dana Levi\n", "speaker 2\n"]);
    assert.equal((await r.run("quiet", "on", "--json")).code, 0);
    assert.equal((await r.run("quiet", "maybe", "--json")).code, 2);
    assert.equal((await r.run("stop", "--delete", "--json")).code, 6, "delete needs --yes");
    assert.equal(c.written.includes("stop-delete\n"), false);
    const st = await r.run("stop", "--json", "--no-wait");
    assert.equal(st.code, 0, st.out);
    assert.ok(c.written.includes("stop\n"));
    c.emit("exit", 0);
    assert.equal((await r.run("status", "--json")).json.call.phase, "idle");
    assert.equal((await r.run("stop", "--json")).code, 4, "nothing to stop");
  } finally {
    await r.done();
  }
});

test("socket: practice, stop --delete --yes, rate limit on start/stop, no call content in the log", async () => {
  let t = 1_000_000;
  const r = await rig({ now: () => t });
  try {
    assert.equal((await r.run("start", "--practice", "--no-wait", "--json")).code, 0);
    assert.equal(r.f.spawned[0].opts.env.WINGMAN_STT_SCRIPT !== undefined, true, "practice uses scripted STT");
    t += 100;
    assert.equal(r.asked.start, 0, "practice never asks");
    r.f.spawned[0].say("consented");
    assert.equal((await r.run("ask", "secret question about invoice 12345", "--json")).code, 0);
    assert.equal((await r.run("stop", "--delete", "--yes", "--no-wait", "--json")).code, 0);
    assert.ok(r.f.spawned[0].written.includes("stop-delete\n"));
    assert.equal(r.asked.del, 1, "delete asked once");
    r.f.spawned[0].emit("exit", 0);
    for (let i = 0; i < 8; i++) {
      t += 2000;
      await r.run("start", "--no-wait", "--json");
      r.f.spawned.at(-1).emit("exit", 0);
    }
    t += 2000;
    assert.equal((await r.run("start", "--no-wait", "--json")).code, 8, "6 per minute");
    t += 61_000;
    assert.equal((await r.run("start", "--no-wait", "--json")).code, 0);
    const log = r.logs.join("\n");
    assert.match(log, /cli ask ok/);
    assert.doesNotMatch(log, /invoice|12345|secret/, "arguments never reach the log");
  } finally {
    await r.done();
  }
});

test("socket: a stop right after a start is NOT rate limited, but a second start is", async () => {
  let t = 1_000_000;
  const r = await rig({ now: () => t });
  try {
    assert.equal((await r.run("start", "--quick", "--no-wait", "--json")).code, 0);
    t += 100;
    assert.equal((await r.run("stop", "--json", "--no-wait")).code, 0, "stop 100 ms after start works");
    r.f.spawned[0].emit("exit", 0);
    t += 100;
    assert.equal((await r.run("start", "--quick", "--no-wait", "--json")).code, 8, "start 100 ms after start is limited");
  } finally {
    await r.done();
  }
});

test("socket: consent from the command line is refused unless it is confirmed in the app (F5)", async () => {
  const no = await rig({ answer: false });
  try {
    await no.run("start", "--practice", "--no-wait", "--json");
    const c = no.f.spawned[0];
    c.say("waiting", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    const x = await no.run("consent", "--yes", "--json");
    assert.equal(x.code, 4, x.out + x.err);
    assert.equal(no.asked.consent, 1);
    assert.deepEqual(c.written, [], "nothing reached the engine");
  } finally {
    await no.done();
  }
});

test("socket: a CLI start asks first (setting on) and is refused without a yes; --practice and the setting off do not ask", async () => {
  const no = await rig({ answer: false });
  try {
    const x = await no.run("start", "--quick", "--no-wait", "--json");
    assert.equal(x.code, 4, x.out + x.err);
    assert.equal(no.f.spawned.length, 0, "nothing started");
    assert.equal(no.asked.start, 1);
    assert.equal((await no.run("start", "--practice", "--no-wait", "--json")).code, 0, "practice is exempt");
    assert.equal(no.asked.start, 1);
  } finally {
    await no.done();
  }
  const off = await rig({ askCliStart: false, answer: false });
  try {
    assert.equal((await off.run("start", "--quick", "--no-wait", "--json")).code, 0);
    assert.equal(off.asked.start, 0, "setting off: no question");
  } finally {
    await off.done();
  }
  const yes = await rig();
  try {
    assert.equal((await yes.run("start", "--quick", "--no-wait", "--json")).code, 0);
    assert.equal(yes.asked.start, 1);
  } finally {
    await yes.done();
  }
});

test("socket: stop --delete --yes always needs the user's click; a no keeps the call running; one question at a time", async () => {
  let release: (v: boolean) => void = () => {};
  const r = await rig({
    answer: () =>
      new Promise<boolean>((res) => {
        release = res;
      }),
  });
  try {
    assert.equal((await r.run("start", "--practice", "--no-wait", "--json")).code, 0);
    const first = r.run("stop", "--delete", "--yes", "--no-wait", "--json");
    await new Promise((res) => setTimeout(res, 100));
    const second = await r.run("stop", "--delete", "--yes", "--no-wait", "--json");
    assert.equal(second.code, 4, "second question refused while the first is open");
    release(false);
    const a = await first;
    assert.equal(a.code, 4);
    assert.ok(!r.f.spawned[0].written.includes("stop-delete\n"), "no click, no delete");
    assert.equal(r.ctl.isRunning(), true);
  } finally {
    await r.done();
  }
  // no confirm function at all (an embedder that forgot): delete is refused
  const { createControlServer } = req("../tray/control-socket.cjs");
  const f = fakeSpawn();
  const ctl = createController({ spawn: f.spawnFn, root: ROOT, tmpDir: tmp("nc"), setTimeout: () => 0, kill: () => {}, logPath: "" });
  ctl.practice({ quick: true });
  const srv = createControlServer({ controller: ctl, lib: trayLib, socketPath: join(tmp("ncs"), "c.sock") });
  assert.equal((await srv.handle(JSON.stringify({ v: 1, cmd: "stop_delete", args: { confirm: true } }))).code, "refused");
});

test("plan attach --file: refuses symlinks, secret folders, key-like names and files outside HOME (unless --force)", SYMLINK, async () => {
  const r = await rig();
  try {
    const id = (await r.run("plan", "new", "--who", "Dana", "--goal", "g", "--json")).json.plan.id;
    const att = (...a: string[]) => r.run("plan", "attach", "--id", id, ...a, "--json");
    mkdirSync(join(r.dir, ".ssh"), { recursive: true });
    mkdirSync(join(r.dir, ".config", "wingman"), { recursive: true });
    writeFileSync(join(r.dir, ".ssh", "id_rsa"), "PRIVATE KEY");
    writeFileSync(join(r.dir, ".config", "wingman", "keys.env"), "ANTHROPIC_API_KEY=sk-x");
    writeFileSync(join(r.dir, ".ssh", "notes.txt"), "not a key but in .ssh");
    writeFileSync(join(r.dir, "real.txt"), "Invented background about a hosting migration, long enough to keep. ".repeat(5));
    symlinkSync(join(r.dir, ".ssh", "id_rsa"), join(r.dir, "x.txt"));
    symlinkSync(join(r.dir, "real.txt"), join(r.dir, "link.txt"));
    mkdirSync(join(r.dir, "linkdir"));
    symlinkSync(join(r.dir, ".config", "wingman", "keys.env"), join(r.dir, "linkdir", "k.md"));
    for (const f of ["x.txt", "link.txt", "linkdir/k.md", ".ssh/notes.txt", ".config/wingman/keys.env", ".ssh/id_rsa"]) {
      const x = await att("--file", join(r.dir, f));
      assert.equal(x.code, 4, f + " " + x.out + x.err);
    }
    assert.doesNotMatch((await r.run("plan", "show", id, "--json")).out, /PRIVATE|sk-x/);
    writeFileSync(join(r.dir, ".env.txt"), "A=1");
    writeFileSync(join(r.dir, "secrets.env"), "A=1");
    assert.equal((await att("--file", join(r.dir, ".env.txt"))).code, 4);
    assert.equal((await att("--file", join(r.dir, "secrets.env"))).code, 4);
    assert.equal((await att("--file", join(r.dir, "real.txt"))).code, 0, "a plain file inside HOME works");
    const out = join(tmp("outside"), "o.txt");
    writeFileSync(out, "Invented outside file text, long enough. ".repeat(10));
    assert.equal((await att("--file", out)).code, 4, "outside HOME refused");
    assert.equal((await att("--file", out, "--force")).code, 0, "--force allows outside HOME");
    assert.equal((await att("--file", join(r.dir, "nope.txt"))).code, 5);
  } finally {
    await r.done();
  }
});

test("cli: app not running -> exit 3 with a hint, and nothing is opened", async () => {
  const dir = tmp("noapp");
  let opened = 0;
  try {
    const env = {
      ...process.env,
      WINGMAN_CONTROL_SOCKET: join(dir, "none.sock"),
      WINGMAN_CALLS_DIR: dir,
      WINGMAN_BRIEFS_DIR: join(dir, "b"),
      WINGMAN_USER_SETTINGS: join(dir, "s.yaml"),
    };
    for (const argv of [["start"], ["stop"], ["ask", "hi"], ["note", "hi"], ["speaker", "2", "Dana"], ["status"], ["quiet", "on"], ["client"]]) {
      let out = "";
      const code = await main([...argv, "--json"], {
        env,
        out: (s) => {
          out += s;
        },
        err: () => {},
        openApp: async () => {
          opened++;
        },
      });
      assert.equal(code, 3, argv.join(" "));
      const j = JSON.parse(out.trim().split("\n")[0]);
      assert.ok(j.error?.hint?.includes("wingman app open") || j.app?.hint?.includes("wingman app open"));
    }
    assert.equal(opened, 0, "the CLI never opens the app implicitly");
    assert.equal(
      await main(["app", "open", "--json"], {
        env,
        out: () => {},
        err: () => {},
        sleep: () => Promise.resolve(),
        openApp: async () => {
          opened++;
        },
      }),
      9,
      "opens only on `app open` (test opener does not create the socket)",
    );
    assert.equal(opened, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan: new, list, show, edit by --id, attach, detach, delete (several meetings, same files the app uses)", async () => {
  const r = await rig();
  try {
    const a = await r.run(
      "plan",
      "new",
      "--title",
      "Hosting move",
      "--who",
      "Dana Levi",
      "--kind",
      "vendor",
      "--topic",
      "hosting move",
      "--goal",
      "agree a date",
      "--must",
      "price",
      "--must",
      "downtime",
      "--note",
      "prefers WhatsApp; calls after 5",
      "--json",
    );
    assert.equal(a.code, 0, a.out + a.err);
    assert.equal(a.json.created, true);
    const id = a.json.plan.id;
    assert.equal(a.json.plan.kind, "vendor");
    assert.deepEqual(a.json.plan.mustCover, ["price", "downtime"]);
    assert.equal(a.json.plan.name, "Hosting move");
    assertMode(join(r.dir, "briefs", "plans", id, "meeting.json"), 0o600);
    const b = await r.run("plan", "new", "--who", "Noam Beta", "--at", "23:59", "--json");
    assert.equal(b.code, 0, b.out + b.err);
    assert.ok(b.json.plan.at.length > 0 && b.json.plan.atText.endsWith("23:59"));
    const list = await r.run("plan", "list", "--json");
    assert.equal(list.json.count, 2);
    assert.equal(list.json.plans[0].who, "Noam Beta", "timed meetings come first");
    assert.match((await r.run("plan", "list")).out, /wingman start --plan <id>/);
    // several meetings: nothing is edited or attached by guesswork
    const amb = await r.run("plan", "set", "--goal", "x", "--json");
    assert.equal(amb.code, 2, amb.out);
    assert.match(amb.json.error.message, /2 prepared meetings/);
    assert.equal((await r.run("plan", "attach", "--text", "hello", "--json")).code, 2);
    const e = await r.run("plan", "set", "--id", id, "--add-must", "backups", "--goal", "new goal", "--json");
    assert.equal(e.code, 0, e.out);
    assert.equal(e.json.plan.who, "Dana Levi", "untouched fields are kept");
    assert.equal(e.json.plan.goal, "new goal");
    assert.deepEqual(e.json.plan.mustCover, ["price", "downtime", "backups"]);
    assert.equal(e.json.plan.kind, "vendor");
    assert.equal(e.json.created, false);
    assert.equal((await r.run("plan", "set", "--id", id, "--kind", "wizard", "--json")).code, 2);
    assert.equal((await r.run("plan", "set", "--id", id, "--at", "yesterday-ish", "--json")).code, 2);
    assert.equal((await r.run("plan", "set", "--id", id, "--new", "--who", "x", "--json")).code, 2);
    assert.equal((await r.run("plan", "set", "--id", "mnope0000", "--goal", "x", "--json")).code, 5);
    const att = await r.run("plan", "attach", "--id", id, "--text", "Invented background: Levi Studio runs 12 WordPress sites.", "--json");
    assert.equal(att.code, 0, att.out);
    const md = join(r.dir, "offer.md");
    writeFileSync(md, "# Offer\nHosting 49 per month (invented).");
    const att2 = await r.run("plan", "attach", "--id", id.slice(0, 9), "--file", md, "--json");
    assert.equal(att2.json.attachments.length, 2, "a unique id prefix works");
    assert.equal((await r.run("plan", "attach", "--id", id, "--file", join(r.dir, "x.exe"), "--json")).code, 5);
    writeFileSync(join(r.dir, "bin.dat"), "x");
    assert.equal(
      (await r.run("plan", "attach", "--id", id, "--file", join(r.dir, "bin.dat"), "--json")).code,
      4,
      "other extensions are refused up front (allow-list)",
    );
    const show = await r.run("plan", "show", id, "--json");
    assert.equal(show.json.plan.attachments.length, 2);
    assert.ok(!JSON.stringify(show.json).includes("Levi Studio runs"), "background text is not echoed");
    assert.equal((await r.run("plan", "show", "--json")).json.plan.ready, false, "several meetings and no id: the list, not one plan");
    assert.equal((await r.run("plan", "detach", att.json.id, "--json")).code, 0, "the file id finds its meeting");
    assert.equal((await r.run("plan", "detach", att.json.id, "--json")).code, 5);
    assert.equal((await r.run("plan", "delete", id, "--json")).code, 6, "needs --yes");
    assert.equal((await r.run("plan", "clear", "--json")).code, 2, "the old clear refuses when there are several");
    assert.equal((await r.run("plan", "delete", id, "--yes", "--json")).code, 0);
    assert.equal(existsSync(join(r.dir, "briefs", "plans", id)), false);
    assert.equal((await r.run("plan", "show", id, "--json")).code, 5);
    // exactly one left: the old single-plan commands keep working
    const one = await r.run("plan", "set", "--goal", "only one", "--json");
    assert.equal(one.code, 0, one.out);
    assert.equal(one.json.plan.who, "Noam Beta");
    assert.equal(one.json.created, false);
    assert.equal((await r.run("plan", "show", "--json")).json.plan.goal, "only one");
    assert.equal((await r.run("plan", "clear", "--json")).code, 0);
    assert.equal((await r.run("plan", "show", "--json")).json.plan.ready, false);
    const first = await r.run("prepare", "--who", "Back again", "--json"); // prepare = plan set when flags come first; none exist, so it makes one
    assert.equal(first.json.created, true);
  } finally {
    await r.done();
  }
});

test("start: --quick starts with no Plan and leaves every prepared meeting alone", async () => {
  const r = await rig();
  try {
    const m = r.plans.create({ who: "Dana, Acme", at: Date.now() + 600_000 }).meeting;
    const s = await r.run("start", "--quick", "--json", "--no-wait");
    assert.equal(s.code, 0, s.out + s.err);
    assert.equal(s.json.mode, "quick");
    assert.equal(s.json.plan, null);
    assert.ok(r.f.spawned[0].args.includes("--no-brief") && !r.f.spawned[0].args.includes("--brief"));
    r.f.spawned[0].say("consented", { id: "Q1" });
    assert.equal(r.plans.get(m.id).status, "ready", "a quick call does not use the meeting up");
    const st = await r.run("status", "--json");
    assert.equal(st.json.call.mode, "quick");
    assert.equal(st.json.plans.length, 1);
    assert.equal(st.json.liveCallPlan, null);
  } finally {
    await r.done();
  }
});

test("start: --plan <id> starts with that meeting, which is marked when the call goes live (and only that one) and stays reusable", async () => {
  const r = await rig();
  try {
    const a = r.plans.create({ who: "Dana, Acme", mustCover: ["price"] }).meeting,
      b = r.plans.create({ who: "Noam, Beta" }).meeting;
    assert.equal((await r.run("start", "--plan", "mnope0000", "--json")).code, 5);
    assert.equal((await r.run("start", "--plan", a.id, "--quick", "--json")).code, 2);
    assert.equal(r.f.spawned.length, 0);
    const s = await r.run("start", "--plan", a.id, "--json", "--no-wait");
    assert.equal(s.code, 0, s.out + s.err);
    assert.equal(s.json.mode, "plan");
    assert.equal(s.json.plan.id, a.id);
    const args = r.f.spawned[0].args;
    assert.equal(args[args.indexOf("--brief") + 1], join(r.plans.dirOf(a.id), "brief.yaml"));
    assert.equal(r.f.spawned[0].opts.env.WINGMAN_ATTACH_DIR, join(r.plans.dirOf(a.id), "files"));
    const st = await r.run("status", "--json");
    assert.equal(st.json.call.planId, a.id);
    assert.equal(st.json.liveCallPlan.name, "Dana, Acme");
    r.f.spawned[0].say("consented", { id: "R1" });
    r.f.spawned[0].say("memory");
    assert.equal(r.plans.get(a.id).uses, 1);
    assert.equal(r.plans.get(b.id).uses, 0);
    assert.equal((await r.run("status", "--json")).json.plans.length, 2, "a used meeting stays in the list");
    r.f.spawned[0].emit("exit", 0);
    assert.equal((await r.run("start", "--plan", a.id, "--json", "--no-wait")).code, 0, "and can start again");
  } finally {
    await r.done();
  }
});

test("start: plain `wingman start` never guesses a Plan (no meetings = quick; one due within 30 min = that one; otherwise refused with the list)", async () => {
  const r = await rig();
  try {
    const none = await r.run("start", "--json", "--no-wait"); // nothing prepared: same as before the feature
    assert.equal(none.code, 0, none.out);
    assert.equal(none.json.mode, "quick");
    assert.match(none.json.reason, /no prepared meetings/);
    r.f.spawned[0].emit("exit", 0);
    const soon = r.plans.create({ who: "Dana, Acme", at: Date.now() + 10 * 60_000 }).meeting;
    r.plans.create({ who: "Noam, Beta", at: Date.now() + 5 * 3600_000 });
    r.plans.create({ who: "No time" });
    const one = await r.run("start", "--json", "--no-wait");
    assert.equal(one.code, 0, one.out + one.err);
    assert.equal(one.json.mode, "plan");
    assert.equal(one.json.plan.id, soon.id);
    r.f.spawned[1].emit("exit", 0);
    const two = r.plans.create({ who: "Also due", at: Date.now() + 20 * 60_000 }).meeting;
    const amb = await r.run("start", "--json");
    assert.equal(amb.code, 2, amb.out);
    assert.equal(amb.json.error.code, "choose_plan");
    assert.match(amb.json.error.message, new RegExp(soon.id));
    assert.match(amb.json.error.message, new RegExp(two.id));
    assert.match(amb.json.error.hint, /--quick/);
    assert.equal(r.f.spawned.length, 2, "nothing was started");
    r.plans.remove(soon.id);
    r.plans.remove(two.id);
    const far = await r.run("start", "--json"); // meetings exist but none is due now
    assert.equal(far.code, 2);
    assert.match(far.json.error.message, /none is due within 30 minutes/);
    assert.equal((await r.run("start", "--quick", "--json", "--no-wait")).code, 0, "--quick always works");
  } finally {
    await r.done();
  }
});

test("start --practice: uses the next meeting, --plan <id>, or none with --quick, and never uses a meeting up", async () => {
  const r = await rig();
  try {
    const m = r.plans.create({ who: "Dana", at: Date.now() + 3600_000 }).meeting;
    const p = await r.run("start", "--practice", "--json", "--no-wait");
    assert.equal(p.code, 0, p.out + p.err);
    assert.equal(p.json.plan.id, m.id);
    assert.ok(r.f.spawned[0].args.includes("--brief"));
    r.f.spawned[0].say("consented", { id: "P1" });
    assert.equal(r.plans.get(m.id).status, "ready");
    r.f.spawned[0].emit("exit", 0);
    const q = await r.run("start", "--practice", "--quick", "--json", "--no-wait");
    assert.equal(q.json.mode, "quick");
    assert.ok(r.f.spawned[1].args.includes("--no-brief"));
  } finally {
    await r.done();
  }
});

test("socket: start/practice arguments are validated", async () => {
  const r = await rig();
  try {
    assert.equal((await r.raw('{"v":1,"cmd":"start","args":{"quick":true,"planId":"mabc12345"}}\n')).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"start","args":{"planId":5}}\n')).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"start","args":{"planId":"x","cmd":"rm"}}\n')).code, "bad_args");
    assert.equal((await r.raw(JSON.stringify({ v: 1, cmd: "start", args: { planId: "m".repeat(41) } }) + "\n")).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"practice","args":{"x":1}}\n')).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"start","args":{"planId":"mnope0000"}}\n')).code, "not_found");
  } finally {
    await r.done();
  }
});

function makeCall(callsDir: string, id: string) {
  const d = join(callsDir, id);
  mkdirSync(d, { recursive: true });
  const t0 = Date.parse("2026-11-02T09:00:00Z");
  const j = (rows: object[]) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(
    join(d, "call.json"),
    JSON.stringify({ startedAt: new Date(t0).toISOString(), endedAt: new Date(t0 + 120000).toISOString(), mode: "file", profile: "demo" }),
  );
  writeFileSync(
    join(d, "transcript.jsonl"),
    j([
      { t: t0 + 1000, ch: "them", text: "How much is hosting?" },
      { t: t0 + 9000, ch: "me", text: "Let me check." },
    ]),
  );
  writeFileSync(
    join(d, "cards.jsonl"),
    j([{ id: "c1", turnId: "t1", badge: "bank", question: "How much is hosting?", say: "Invented card: ask about traffic first.", at: t0 + 2000 }]),
  );
  writeFileSync(
    join(d, "events.jsonl"),
    j([
      { t: t0, type: "start" },
      { t: t0 + 120000, type: "end" },
    ]),
  );
  writeFileSync(
    join(d, "summary.json"),
    JSON.stringify({
      v: 1,
      generatedAt: "x",
      model: "scripted",
      summary: ["Talked about hosting."],
      decisions: ["Move in December"],
      nextSteps: [{ who: "דן", what: "Send an offer" }],
      openQuestions: ["Backup size?"],
      followUpEmail: "Hi Dana,\nthanks for the call.\nDan",
      costUsd: 0,
    }),
  );
}

test("calls: list, show, summary, email, rate, purge (needs --yes), live snapshot", async () => {
  const r = await rig();
  const id = "01HXTESTCALL0000000000AAAA";
  try {
    makeCall(join(r.dir, "calls"), id);
    const l = await r.run("calls", "list", "--json");
    assert.equal(l.json.calls[0].id, id);
    assert.equal(l.json.calls[0].hasSummary, true);
    const s = await r.run("calls", "show", "latest", "--json");
    assert.equal(s.json.transcript.length, 2);
    assert.equal(s.json.cards[0].id, "c1");
    assert.match((await r.run("calls", "summary", id)).out, /Move in December/);
    assert.match((await r.run("calls", "email", id)).out, /thanks for the call/);
    assert.equal((await r.run("calls", "rate", id, "c1", "y", "--json")).code, 0);
    assert.equal((await r.run("calls", "show", id, "--json")).json.cards[0].rating, "y");
    assert.equal((await r.run("calls", "rate", id, "nope", "y", "--json")).code, 5);
    assert.equal((await r.run("calls", "rate", id, "c1", "maybe", "--json")).code, 2);
    const lv = await r.run("live", "--id", id, "--json");
    assert.equal(lv.code, 0, lv.out);
    assert.equal(lv.json.lines[0].cards[0].say.startsWith("Invented card"), true);
    assert.equal((await r.run("live", "--follow", "--id", id, "--json")).code, 4, "follow needs a running call");
    for (const bad of ["abc", "0", "-3"])
      assert.equal((await r.run("live", "--follow", "--timeout", bad, "--id", id, "--json")).code, 2, `--timeout ${bad} is a usage error`);
    assert.equal((await r.run("calls", "show", "../etc", "--json")).code, 2);
    assert.equal((await r.run("calls", "show", "01HXTESTCALL0000000000ZZZZ", "--json")).code, 5);
    assert.equal((await r.run("calls", "purge", id, "--json")).code, 6);
    assert.ok(existsSync(join(r.dir, "calls", id)));
    assert.equal((await r.run("calls", "purge", id, "--yes", "--json")).code, 0);
    assert.equal(existsSync(join(r.dir, "calls", id)), false);
    assert.equal((await r.run("calls", "summary", "latest", "--json")).code, 5);
  } finally {
    await r.done();
  }
});

test("settings: list/get/set use the app's catalog and validation; keys.* is off limits", async () => {
  const r = await rig();
  try {
    const l = await r.run("settings", "list", "--json");
    assert.ok(l.json.settings.some((s: any) => s.key === "overlay.liveTextPt"));
    assert.equal((await r.run("settings", "set", "overlay.liveTextPt", "20", "--json")).code, 0);
    assert.equal((await r.run("settings", "get", "overlay.liveTextPt", "--json")).json.setting.value, 20);
    assert.equal((await r.run("settings", "set", "overlay.liveTextPt", "0", "--json")).code, 2);
    assert.equal((await r.run("settings", "set", "run.noAi", "off", "--json")).code, 0);
    assert.equal((await r.run("settings", "get", "run.noAi", "--json")).json.setting.value, false);
    assert.equal((await r.run("settings", "set", "stt.language", "klingon", "--json")).code, 2);
    assert.equal((await r.run("settings", "set", "overlay.liveTextPt", "default", "--json")).code, 0);
    assert.equal((await r.run("settings", "get", "overlay.liveTextPt", "--json")).json.setting.changed, false);
    assert.equal((await r.run("settings", "set", "keys.file", "/tmp/x", "--advanced", "--json")).code, 4);
    assert.equal((await r.run("settings", "set", "audio.mic.device", ":1", "--json")).code, 5, "not in the catalog without --advanced");
    assert.equal((await r.run("settings", "set", "nope.nothing", "1", "--advanced", "--json")).code, 5);
    assert.ok(statSync(join(r.dir, "settings.yaml")).mode & 0o600);
  } finally {
    await r.done();
  }
});

test("keys: status only, never a value or its last characters; set/migrate refused", async () => {
  const r = await rig();
  try {
    const secret = "sk-ant-api03-SUPERSECRETVALUE1234";
    const keychain = { get: (p: string) => (p === "anthropic" ? secret : null), set: () => true, remove: () => false };
    let out = "";
    const code = await main(["keys", "status", "--json"], {
      env: { ...r.env, WINGMAN_KEYS_FILE: join(r.dir, "nokeys.env"), DEEPGRAM_API_KEY: "" },
      keychain,
      out: (s) => {
        out += s;
      },
      err: () => {},
    });
    assert.equal(code, 7, "deepgram missing -> not ready");
    const j = JSON.parse(out);
    assert.equal(j.keys.find((k: any) => k.key === "anthropic").present, true);
    assert.equal(j.keys.find((k: any) => k.key === "deepgram").present, false);
    assert.ok(!out.includes(secret) && !out.includes("1234") && !out.includes("sk-ant"));
    for (const sub of ["set", "migrate", "remove"]) assert.equal((await r.run("keys", sub, "deepgram", "--json")).code, 4);
  } finally {
    await r.done();
  }
});

test("help: agent manual mentions every command; exit codes documented; usage errors exit 2", async () => {
  const r = await rig();
  try {
    for (const w of [
      "status",
      "doctor",
      "plan",
      "prepare",
      "start",
      "stop",
      "ask",
      "speaker",
      "live",
      "calls",
      "settings",
      "keys status",
      "app open",
      "--json",
      "--yes",
      "EXIT CODES",
    ])
      assert.ok(HELP.includes(w), w);
    const h = await r.run("help");
    assert.equal(h.code, 0);
    assert.match(h.out, /for an AI agent/);
    assert.equal((await r.run("help", "--json")).json.ok, true);
    assert.equal((await r.run("start", "--bogus", "--json")).code, 2);
    assert.equal((await r.run("start", "--practice", "--no-ai", "--json")).code, 2);
    assert.equal((await r.run("nonsense", "--json")).code, 2);
    assert.equal((await r.run("doctor", "--help")).code, 0);
  } finally {
    await r.done();
  }
});

test("doctor: runs directly when the app is not there (scripted runner), exit 7 on NOT READY", async () => {
  const dir = tmp("doc");
  try {
    const env = {
      ...process.env,
      WINGMAN_CONTROL_SOCKET: join(dir, "none.sock"),
      WINGMAN_CALLS_DIR: dir,
      WINGMAN_BRIEFS_DIR: dir,
      WINGMAN_USER_SETTINGS: join(dir, "s.yaml"),
    };
    const run = (out: string) => {
      let o = "";
      return main(["doctor", "--offline", "--json"], {
        env,
        out: (s) => {
          o += s;
        },
        err: () => {},
        spawnTsx: async () => ({ code: 1, out }),
      }).then((code) => ({ code, j: JSON.parse(o) }));
    };
    const bad = await run("Wingman doctor\n  ❌ DEEPGRAM_API_KEY missing\n     fix: add it\nNOT READY\n");
    assert.equal(bad.code, 7);
    assert.equal(bad.j.failing[0].fix, "add it");
    const ok = await run("  ⚠️  only one screen\n     fix: connect it\nREADY WITH WARNINGS\n");
    assert.equal(ok.code, 0);
    assert.equal(ok.j.warnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "hidden instance: the real controller + scripted engine (file mode) driven through the socket by the CLI",
  { timeout: 90_000, ...ENGINE_CHILD },
  async () => {
    const dir = tmp("eng");
    const wav = join(dir, "silence.wav");
    await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 30), 2);
    // Same controller as the app; only the child command is swapped from call.ts (which opens the answer window) to run.ts in scripted file mode.
    const realSpawn = spawn;
    const spawnEngine = (bin: string, args: string[], opts: any) =>
      realSpawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"]), {
        ...opts,
        env: {
          ...opts.env,
          WINGMAN_CALLS_DIR: join(dir, "calls"),
          WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json"),
          WINGMAN_SCRIPT_GAP_MS: "1100",
        },
      });
    const r = await rig({ spawn: spawnEngine, callsDir: join(dir, "calls") });
    try {
      const s = await r.run("start", "--json");
      assert.equal(s.code, 0, s.out + s.err);
      assert.ok(["live", "waiting"].includes(s.json.phase), s.out);
      assert.equal((await r.run("start", "--json")).code, 4, "no second engine");
      let id = "",
        lines = 0;
      for (let i = 0; i < 60 && !lines; i++) {
        await new Promise((res) => setTimeout(res, 500));
        const st = await r.run("status", "--json");
        id = st.json.call.callId;
        const lv = await r.run("live", "--json").catch(() => undefined);
        lines = lv?.json?.lines?.length ?? 0;
      }
      assert.ok(id && lines > 0, "transcript lines are readable through the CLI while the call runs");
      assert.equal((await r.run("note", "invented note about a server move", "--json")).code, 0);
      assert.equal((await r.run("quiet", "on", "--json")).code, 0);
      assert.equal((await r.run("quiet", "off", "--json")).code, 0);
      const aq = await r.run("ask", "what was the price", "--json");
      assert.equal(aq.code, 0);
      assert.equal(aq.json.engineSupportsAsk, true);
      assert.equal((await r.run("ask", "--listen", "--json")).code, 0);
      const stop = await r.run("stop", "--json");
      assert.equal(stop.code, 0, stop.out);
      assert.equal(stop.json.finished, true);
      const list = await r.run("calls", "list", "--json");
      assert.ok(
        list.json.calls.some((c: any) => c.id === id),
        "the call was saved in the temp calls dir",
      );
      const events = readFileSync(join(dir, "calls", id, "events.jsonl"), "utf8");
      assert.match(events, /context\.note/);
      assert.match(events, /"reason":"typed"/, "the typed question reached the engine as a forced question");
      assert.equal((await r.run("calls", "purge", id, "--yes", "--json")).code, 0);
    } finally {
      await r.done();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("stop --no-summary: keeps the call, sends stop-no-summary, refuses --delete, help documents it", async () => {
  const r = await rig();
  try {
    assert.ok(HELP.includes("--no-summary"));
    await r.run("start", "--json", "--no-wait");
    const c = r.f.spawned[0];
    c.say("consented", { id: "S3" });
    assert.equal((await r.run("stop", "--no-summary", "--delete", "--yes", "--json")).code, 2);
    const st = await r.run("stop", "--no-summary", "--json", "--no-wait");
    assert.equal(st.code, 0, st.out);
    assert.deepEqual(c.written, ["stop-no-summary\n"]);
    assert.equal(st.json.summarySkipped, true);
    assert.equal(st.json.deleted, false);
    r.f.spawned[0].emit("exit", 0);
    await r.run("start", "--json", "--no-wait");
    const c2 = r.f.spawned[1];
    c2.say("consented", { id: "S5" });
    assert.match((await r.run("stop", "--no-summary", "--no-wait")).out, /wingman calls summary S5 --generate/);
  } finally {
    await r.done();
  }
});

test("status: shows the seconds left while Ctrl+Opt+A is armed (--json: questionSecondsLeft)", async () => {
  const r = await rig();
  try {
    await r.run("start", "--no-wait", "--json");
    r.f.spawned[0].say("consented", { id: "S4" });
    r.f.spawned[0].say("ask", { on: true, until: Date.now() + 9500 });
    const j = (await r.run("status", "--json")).json;
    assert.equal(j.call.listeningForQuestion, true);
    assert.ok(j.call.questionSecondsLeft >= 8 && j.call.questionSecondsLeft <= 10, String(j.call.questionSecondsLeft));
    assert.match((await r.run("status")).out, /listening for your question \(\d+ s left\)/);
    r.f.spawned[0].say("ask", { on: false });
    assert.equal((await r.run("status", "--json")).json.call.questionSecondsLeft, null);
  } finally {
    await r.done();
  }
});

test("status: shows the stop step while a call is being saved, and the listening-for-question state", async () => {
  const r = await rig();
  try {
    await r.run("start", "--no-wait", "--json");
    r.f.spawned[0].say("consented", { id: "S1" });
    r.f.spawned[0].say("ask", { on: true });
    const a = await r.run("status");
    assert.match(a.out, /listening for your question/);
    assert.equal((await r.run("status", "--json")).json.call.aiMode, "ai");
    r.f.spawned[0].say("mode", { noAi: true });
    assert.equal((await r.run("status", "--json")).json.call.aiMode, "prepared-only");
    r.f.spawned[0].say("stopping");
    r.f.spawned[0].say("stopphase", { phase: "summary" });
    const b = await r.run("status"),
      j = (await r.run("status", "--json")).json;
    assert.match(b.out, /stopping .*writing the summary/);
    assert.equal(j.call.stopPhase, "summary");
    assert.equal(j.call.listeningForQuestion, false);
  } finally {
    await r.done();
  }
});

// ---- recap, ask (waits for the answer) and followup ----
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
async function liveCall(r: Awaited<ReturnType<typeof rig>>) {
  assert.equal((await r.run("start", "--json", "--no-wait")).code, 0);
  const c = r.f.spawned[0];
  c.say("waiting", { id: ID });
  assert.equal((await r.run("consent", "--yes", "--json")).code, 0);
  c.say("consented");
  const dir = join(r.dir, "calls", ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "call.json"), JSON.stringify({ id: ID, startedAt: new Date().toISOString() }));
  return { c, dir };
}
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

test("cli: recap on a live call sends 'recap' to the engine and prints what the engine wrote", async () => {
  const r = await rig();
  try {
    const { c, dir } = await liveCall(r);
    const text = "Where we are: Planning\nYou promised: send the plan";
    later(120, () =>
      appendFileSync(
        join(dir, "events.jsonl"),
        JSON.stringify({
          type: "recap.done",
          at: Date.now(),
          recap: { where: "Planning", decided: [], open: [], promised: ["send the plan"], asked: [] },
          text,
          source: "ai",
          ai: true,
        }) + "\n",
      ),
    );
    const out = await r.run("recap", "--json");
    assert.equal(out.code, 0, out.out + out.err);
    assert.ok(c.written.includes("recap\n"), "the engine got the recap command");
    assert.equal(out.json.ai, true);
    assert.deepEqual(out.json.recap.promised, ["send the plan"]);
    const plain = await r.run("recap", "--no-wait");
    assert.match(plain.out, /requested/);
    // nothing written in time: a timeout, not an invented answer
    const slow = await r.run("recap", "--wait", "1", "--json");
    assert.equal(slow.code, 9);
  } finally {
    await r.done();
  }
});

test("cli: ask waits for ask.done with the same question and prints the answer; --no-wait and a slow engine do not hang", async () => {
  const r = await rig();
  try {
    const { c, dir } = await liveCall(r);
    later(120, () =>
      appendFileSync(
        join(dir, "events.jsonl"),
        JSON.stringify({ type: "ask.done", at: Date.now(), question: "who owns the domain?", text: "Noa does.", source: "call", ai: true }) + "\n",
      ),
    );
    const a = await r.run("ask", "who owns the domain?", "--json");
    assert.equal(a.code, 0, a.out + a.err);
    assert.equal(a.json.answered, true);
    assert.equal(a.json.answer, "Noa does.");
    assert.ok(c.written.includes("ask who owns the domain?\n"));
    const slow = await r.run("ask", "another one?", "--wait", "1", "--json");
    assert.equal(slow.code, 0);
    assert.equal(slow.json.answered, false);
    assert.equal((await r.run("ask", "x?", "--no-wait", "--json")).json.answered, undefined);
  } finally {
    await r.done();
  }
});

test("cli: recap and followup of a saved call read session.json (no app, no model)", async () => {
  const calls = tmp("calls");
  const dir = join(calls, ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "call.json"), JSON.stringify({ id: ID, startedAt: new Date().toISOString() }));
  const mem = applyPatch(
    emptyMemory(1, "client"),
    {
      topic: "Hosting move",
      add: {
        decisions: [{ text: "Move in two steps" }],
        commitments: [{ who: "me", what: "send the plan", due: "Friday" }],
        openQuestions: [{ asker: "Noa", text: "Can the old site stay up?" }],
      },
    },
    { now: 2 },
  ).mem;
  saveMemory(dir, mem);
  const r = await rig({ callsDir: calls });
  try {
    const rc = await r.run("recap", "--id", ID, "--json");
    assert.equal(rc.code, 0, rc.out + rc.err);
    assert.equal(rc.json.ai, false);
    assert.deepEqual(rc.json.recap.promised, ["send the plan (Friday)"]);
    assert.match((await r.run("recap", "--id", ID)).out, /AI offline: from notes/);
    const fu = await r.run("followup", ID, "--json");
    assert.equal(fu.code, 0, fu.out + fu.err);
    assert.equal(fu.json.source, "memory");
    assert.match(fu.json.text, /Move in two steps/);
    assert.doesNotMatch(fu.json.text, /Friday/);
    // a call with no saved memory: not found, with a hint
    const empty = join(calls, "01ARZ3NDEKTSV4RRFFQ69G5FAW");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "call.json"), JSON.stringify({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", startedAt: new Date().toISOString() }));
    assert.equal((await r.run("followup", "01ARZ3NDEKTSV4RRFFQ69G5FAW", "--json")).code, 5);
  } finally {
    await r.done();
  }
});

test("cli: digest keeps the raw text as plain background without a key, saves digest.json (mode 600), and refuses a bad file", async () => {
  const h = tmp("digest");
  const out = join(h, "digest.json");
  writeFileSync(join(h, "notes.txt"), "Agenda: hosting move.\nNoa asked about downtime.\n");
  // the keys file is a path inside the temp folder (settings key keys.file), so the real ~/.config/wingman/keys.env is never read
  writeFileSync(join(h, "settings.yaml"), `keys:\n  file: ${JSON.stringify(join(h, "nokeys.env"))}\n`);
  const run = async (...argv: string[]) => {
    let o = "",
      e = "";
    const code = await main(argv, {
      env: { ...process.env, HOME: h, WINGMAN_USER_SETTINGS: join(h, "settings.yaml"), ANTHROPIC_API_KEY: "" },
      home: h,
      keychain: { get: () => null, set: () => true, remove: () => false }, // a stub: the test never touches the real Keychain
      out: (s) => (o += s),
      err: (s) => (e += s),
      stdin: async () => "from stdin",
    });
    return {
      code,
      out: o,
      err: e,
      json: (() => {
        try {
          return JSON.parse(o.trim().split("\n")[0]);
        } catch {
          return undefined;
        }
      })(),
    };
  };
  const r = await run("digest", join(h, "notes.txt"), "--text", "Meeting with Noa on Monday", "--out", out, "--json");
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.source, "raw");
  assert.equal(r.json.why, "no-ai");
  assert.ok(r.json.digest.chunks.some((c: { source: string }) => c.source === "notes.txt"));
  assert.equal(JSON.parse(readFileSync(out, "utf8")).digest.chunks.length, 2);
  if (POSIX) assertMode(out, 0o600);
  assert.equal((await run("digest", "--stdin", "--json")).json.source, "raw");
  assert.equal((await run("digest", "--json")).code, 2, "nothing to digest is a usage error");
  assert.equal((await run("digest", join(h, "missing.txt"), "--json")).code, 5);
});
