import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEchoMode } from "./echo.ts";

test("auto echo mode: headphones keep the mic open, the Mac speakers gate it", () => {
  const dev = (name: string, transport: string) => ({ name, transport, defaultInput: false, defaultOutput: true });
  assert.equal(resolveEchoMode("auto", [dev("HD 450BT", "coreaudio_device_type_bluetooth")]), "filter");
  assert.equal(resolveEchoMode("auto", [dev("External Headphones", "coreaudio_device_type_builtin")]), "filter");
  assert.equal(resolveEchoMode("auto", [dev("MacBook Pro Speakers", "coreaudio_device_type_builtin")]), "both");
  assert.equal(resolveEchoMode("auto", []), "filter");
  assert.equal(resolveEchoMode("gate", [dev("HD 450BT", "coreaudio_device_type_bluetooth")]), "gate");
});
