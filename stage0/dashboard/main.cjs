// `pnpm dashboard` / `electron dashboard/main.cjs`: the same app as `pnpm tray`, started with the Wingman window open.
// (The window itself lives in dashboard/window.cjs and is hosted by tray/main.cjs; a second launch focuses the open window.)
process.env.WINGMAN_OPEN_WINDOW = "1";
require("../tray/main.cjs");
