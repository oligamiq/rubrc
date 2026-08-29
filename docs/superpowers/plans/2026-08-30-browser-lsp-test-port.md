# Browser LSP Test Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the real browser LSP acceptance test to use a validated `PORT` override while preserving port 4173 as its default.

**Architecture:** Parse and validate `PORT` once at browser test startup, then derive both the test URL and static-server listen port from that value. Extend the existing source contract test before changing the runner, and finish by running the real Chromium semantic acceptance on port 4174.

**Tech Stack:** Bun, Deno tests, Node HTTP server, Puppeteer/Chromium

## Global Constraints

- `PORT` defaults to `4173` when unset.
- Valid ports are safe integers from 1 through 65535 inclusive.
- The validated port is the single source for the base URL, metadata URL, server listen address, and browser navigation.
- The existing Pages preview on port 4173 must remain running and unchanged.
- Do not stage or modify unrelated existing worktree changes.

---

### Task 1: Validated Browser Acceptance Port

**Files:**
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs:17-18,247-253`

**Interfaces:**
- Consumes: `process.env.PORT: string | undefined` and `startBrowserStaticServer({ hostname, port })`
- Produces: `port: number`, validated before browser startup, and `url: string` in the form `http://127.0.0.1:<port>`

- [ ] **Step 1: Write the failing source contract**

Append this test to `scripts/lsp_browser_diagnostics_contract_test.ts`:

```ts
Deno.test("browser acceptance supports a validated port override", async () => {
  const source = await Deno.readTextFile(
    "scripts/lsp_browser_diagnostics_test.mjs",
  );
  const portIndex = source.indexOf(
    'const port = Number(process.env.PORT ?? "4173")',
  );
  const urlIndex = source.indexOf(
    "const url = `http://127.0.0.1:${port}`",
    portIndex,
  );
  const listenIndex = source.indexOf("port,", urlIndex);

  assert(portIndex >= 0, "browser acceptance does not read the PORT override");
  assert(
    source.includes("!Number.isSafeInteger(port)") &&
      source.includes("port < 1") &&
      source.includes("port > 65_535"),
    "browser acceptance does not validate the selected port",
  );
  assert(
    urlIndex > portIndex,
    "browser acceptance URL does not use the validated port",
  );
  assert(
    listenIndex > urlIndex,
    "browser static server does not use the validated port",
  );
});
```

- [ ] **Step 2: Run the contract to verify it fails**

Run:

```bash
deno test --allow-read scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: FAIL in `browser acceptance supports a validated port override` with `browser acceptance does not read the PORT override`; the existing 19 tests pass.

- [ ] **Step 3: Implement the minimal validated override**

Replace the fixed URL declarations at the top of `scripts/lsp_browser_diagnostics_test.mjs` with:

```js
const port = Number(process.env.PORT ?? "4173");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`invalid browser acceptance port: ${process.env.PORT}`);
}
const url = `http://127.0.0.1:${port}`;
const expectedMetadataUrl = new URL("/.rubrc-pages-build.json", url).href;
```

Change the static-server startup to use the same value:

```js
  staticServer = await startBrowserStaticServer({
    hostname: "127.0.0.1",
    port,
  });
```

- [ ] **Step 4: Run focused static verification**

Run:

```bash
deno test --allow-read scripts/lsp_browser_diagnostics_contract_test.ts
node --check scripts/lsp_browser_diagnostics_test.mjs
```

Expected: all 20 Deno contract tests pass and Node syntax checking exits 0.

- [ ] **Step 5: Run the real Chromium semantic acceptance**

The page build and assets are already prepared. Run:

```bash
PORT=4174 bun scripts/lsp_browser_diagnostics_test.mjs
```

Expected: the in-process server listens on port 4174, Chromium completes the diagnostics, completion, definition, remount, and cleanup assertions, and the command exits 0 while the existing port-4173 Pages preview remains alive.

- [ ] **Step 6: Commit only the port override files**

```bash
git add scripts/lsp_browser_diagnostics_contract_test.ts scripts/lsp_browser_diagnostics_test.mjs
git commit -m "test: allow browser acceptance port override"
```
