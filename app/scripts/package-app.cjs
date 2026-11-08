"use strict";
// Builds the self-contained Wingman.app and .dmg into app/dist (`pnpm dist`). Needs a normal `pnpm install` (esbuild, electron-builder).
//   1. .stage/   the app folder as the packaged app sees it: tray, dashboard, overlay, shared, config, the example pack, the demo data,
//                the engine (src/*.ts bundled with esbuild into src/*.mjs, run by the app's own Electron: see tray/app-entry.cjs), audiotee.
//   2. electron-builder packs .stage into dist/mac-arm64/Wingman.app and dist/Wingman-<version>-arm64.dmg (electron-builder.cjs).
//   --stage-only   stop after step 1 (to look at or test the stage).     --dir   build the .app only, no .dmg.
// The dev setup (pnpm, tsx, install.sh) does not use any of this.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP = path.join(__dirname, "..");
const STAGE = path.join(APP, ".stage");
const pkg = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
const { PACKED_TOOLS } = require("../shared/bin.cjs");
const argv = process.argv.slice(2);

const copy = (rel, filter) => fs.cpSync(path.join(APP, rel), path.join(STAGE, rel), { recursive: true, dereference: true, filter });
/** Folder of an installed package (walks up from its entry file; some packages do not export package.json). */
function packageDir(name) {
  let d = path.dirname(require.resolve(name, { paths: [APP] }));
  while (!fs.existsSync(path.join(d, "package.json")) || JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).name !== name) d = path.dirname(d);
  return d;
}
const skip = (f) => !/\.test\.[cm]?[jt]s$/.test(f) && !f.endsWith("snapshot.sh") && !f.endsWith(".DS_Store");

async function bundleEngine() {
  const esbuild = require("esbuild");
  // The bundle is ESM, but some packages and our own .cjs files use require / __dirname. Globals, so a module that declares its own name is not in conflict.
  const banner = [
    'import { createRequire as __wmCreateRequire } from "node:module";',
    'import { fileURLToPath as __wmFileURLToPath } from "node:url";',
    'import { dirname as __wmDirname } from "node:path";',
    "globalThis.require ??= __wmCreateRequire(import.meta.url);",
    "globalThis.__filename ??= __wmFileURLToPath(import.meta.url);",
    "globalThis.__dirname ??= __wmDirname(globalThis.__filename);",
  ].join("\n");
  // Two source patterns do not survive bundling and are rewritten while it reads the files.
  // 1. Several files run themselves only when started directly: `if (process.argv[1] === fileURLToPath(import.meta.url)) main()`.
  // In a bundle that test is wrong (a file can be inside another entry or a shared chunk), so it becomes: the tool the app was asked
  // to run (globalThis.__wmTool, set by tray/app-entry.cjs) is this file.
  const GUARD = /process\.argv\[1\]\s*===\s*fileURLToPath\(import\.meta\.url\)/g;
  const selfRun = {
    name: "self-run-guard",
    setup(b) {
      b.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, (a) => {
        let src = fs.readFileSync(a.path, "utf8").replace(GUARD, `globalThis.__wmTool === ${JSON.stringify(path.basename(a.path, ".ts"))}`);
        if (a.path.endsWith(path.join("providers", "llm.ts"))) {
          // import(pkg) with a variable cannot be bundled: list the providers the app carries. Others fail like a missing package.
          const before = src;
          src = src.replace(
            "(pkg) => import(pkg);",
            '(pkg) => pkg === "@ai-sdk/anthropic" ? import("@ai-sdk/anthropic") : pkg === "./scripted.ts" ? import("./scripted.ts") : Promise.reject(Object.assign(new Error(`Cannot find package ${pkg}`), { code: "ERR_MODULE_NOT_FOUND" }));',
          );
          if (src === before) throw new Error("providers/llm.ts changed: update the provider import list in scripts/package-app.cjs");
        }
        return { contents: src, loader: "ts" };
      });
    },
  };
  await esbuild.build({
    plugins: [selfRun],
    entryPoints: PACKED_TOOLS.map((t) => path.join(APP, "src", t + ".ts")),
    outdir: path.join(STAGE, "src"),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    outExtension: { ".js": ".mjs" },
    banner: { js: banner },
    external: ["electron", "bufferutil", "utf-8-validate"], // optional speed-ups of ws, which falls back without them
    legalComments: "none",
    logLevel: "warning",
  });
  for (const f of fs.readdirSync(path.join(STAGE, "src")).filter((n) => n.endsWith(".mjs")))
    if (/argv\[1\]\s*===\s*fileURLToPath/.test(fs.readFileSync(path.join(STAGE, "src", f), "utf8"))) throw new Error(`${f} still has a run-directly test`);
}

async function main() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const d of ["tray", "dashboard", "overlay", "shared", "config"]) copy(d, skip);
  // Shipped data: the example pack, the starter packs (setup step "Starter answers") and the practice-call data. Profiles: the ones a user can pick (practice calls, cautious first call).
  copy(path.join("data", "example-pack"));
  copy(path.join("data", "starter-packs"));
  copy(path.join("data", "demo"));
  for (const need of [
    "example-pack/bank.yaml",
    "starter-packs/sales/bank.yaml",
    "starter-packs/support/bank.yaml",
    "starter-packs/interview/bank.yaml",
    "starter-packs/empty/bank.yaml",
    "demo/demo-call.json",
  ])
    if (!fs.existsSync(path.join(STAGE, "data", need))) throw new Error(`package-app: data/${need} is missing from the stage`);
  fs.mkdirSync(path.join(STAGE, "profiles"));
  for (const p of ["demo", "demo-en", "first-client-call"]) copy(path.join("profiles", p + ".yaml"));
  // Loaded by path at run time (createRequire), so esbuild does not see it.
  fs.mkdirSync(path.join(STAGE, "src"), { recursive: true });
  copy(path.join("src", "keychain.cjs"));
  // audiotee finds its binary at ../bin/audiotee from the bundled code.
  const tee = packageDir("audiotee");
  fs.mkdirSync(path.join(STAGE, "bin"));
  fs.copyFileSync(path.join(tee, "bin", "audiotee"), path.join(STAGE, "bin", "audiotee"));
  fs.chmodSync(path.join(STAGE, "bin", "audiotee"), 0o755);
  await bundleEngine();
  // The menu-bar code reads YAML with the yaml package; it is the only package the stage carries.
  const yamlDir = packageDir("yaml");
  const yamlVersion = JSON.parse(fs.readFileSync(path.join(yamlDir, "package.json"), "utf8")).version;
  fs.cpSync(yamlDir, path.join(STAGE, "node_modules", "yaml"), { recursive: true, dereference: true });
  fs.writeFileSync(path.join(STAGE, "packaged.json"), JSON.stringify({ version: pkg.version }) + "\n"); // marks the packaged app (shared/bin.cjs isPackaged)
  fs.writeFileSync(
    path.join(STAGE, "package.json"),
    JSON.stringify(
      {
        name: "wingman",
        productName: "Wingman",
        version: pkg.version,
        description: pkg.description,
        author: pkg.author,
        homepage: pkg.homepage,
        license: pkg.license,
        main: "tray/app-entry.cjs",
        dependencies: { yaml: yamlVersion },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`staged ${path.relative(process.cwd(), STAGE) || STAGE}`);
  if (argv.includes("--stage-only")) return;

  const cli = require.resolve("electron-builder/cli.js", { paths: [APP] });
  const r = spawnSync(
    process.execPath,
    [cli, "--mac", argv.includes("--dir") ? "dir" : "dmg", "--arm64", "--config", path.join(APP, "electron-builder.cjs"), "--projectDir", APP],
    {
      cwd: APP,
      stdio: "inherit",
      env: process.env,
    },
  );
  process.exit(r.status ?? 1);
}

main().catch((e) => {
  console.error("package-app: " + (e && e.message ? e.message : e));
  process.exit(1);
});
