import assert from "node:assert";

const xterm = await Deno.readTextFile(
  new URL("../page/src/xterm.tsx", import.meta.url),
);

Deno.test("WebShell reserves 64 MiB for multiplexed base-call payloads", () => {
  assert.match(
    xterm,
    /base_call_allocator_size:\s*64\s*\*\s*1024\s*\*\s*1024/,
  );
});
