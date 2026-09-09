# Browser rust-std Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WebShell's bundled rust-analyzer provide practical `core`, `alloc`, and `std` analysis while sourcing rust-src from the same Rust checkout as the published target sysroots.

**Architecture:** The sibling `rust_wasm` repository will package a library-relative `rust-src.tar.br` from the same pinned source ref used by every rustc/sysroot build job. Rubrc will fetch and cache that release artifact during asset preparation, let rust-analyzer discover the sysroot from `sysroot_src`, require all public sysroot crates during readiness, and verify completion, definition navigation, and diagnostics in the existing browser acceptance test.

**Tech Stack:** GitHub Actions, Python `unittest`, Deno/TypeScript, Solid/Vite, Monaco Language Client, rust-analyzer LSP, Puppeteer.

## Global Constraints

- `rust-src` and every compiled target sysroot used by the WebShell are produced from the same Rust source checkout.
- Do not add commit-hash, archive-digest, or embedded-rustc identity verification.
- Preserve existing archive parsing, safe-path checks, and required `core`, `alloc`, `std`, and target `libcore` entry checks.
- Preserve staged startup order: lightweight analyzer startup, sysroot installation, project activation, then semantic readiness.
- Keep build scripts, proc macros, check-on-save, and `cachePriming.enable` disabled.
- Do not rely on persistent rust-analyzer semantic state across page reloads.
- Do not add a Rubrc-owned model of nightly sysroot crate dependencies.

---

### Task 1: Publish rust-src From the Pinned rust_wasm Checkout

**Working directory:** `/home/oligami/projects/rust_wasm`

**Files:**
- Create: `tests/__init__.py`
- Create: `tests/test_release_rust_src_contract.py`
- Modify: `.github/workflows/rustc_llvm_with_lld.yml:5-18,28-50,153-174,265-269,367-395,592-629,631-656,759-783`
- Modify: `.github/workflows/create_release.yml:3-10,45-83,85-135`

**Interfaces:**
- Produces: GitHub Pages asset `https://oligamiq.github.io/rust_wasm/v0.2.1/rust-src.tar.br` whose tar root contains `core/`, `alloc/`, and `std/` directly.
- Produces: workflow-level `env.RUST_SOURCE_REF`, used by all five `oligamiq/rust` checkout steps.
- Produces: one `job=all` workflow run containing `dist-linux`, `dist-macos`, `dist-windows`, and `rustc-bins`; release packaging accepts that run ID rather than mixing latest artifacts from different runs.
- Preserves: existing `dist-linux`, `dist-macos`, `dist-windows`, and `rustc-bins` artifact names.

- [ ] **Step 1: Write the failing workflow contract test**

```python
# tests/test_release_rust_src_contract.py
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
BUILD = (ROOT / ".github/workflows/rustc_llvm_with_lld.yml").read_text()
RELEASE = (ROOT / ".github/workflows/create_release.yml").read_text()


class RustSrcReleaseContractTest(unittest.TestCase):
    def test_all_rust_checkouts_use_one_source_ref(self):
        self.assertIn("RUST_SOURCE_REF: cf327c2068549194a29160499c2ecafa9061e46e", BUILD)
        self.assertEqual(BUILD.count("ref: ${{ env.RUST_SOURCE_REF }}"), 5)
        self.assertNotIn("git checkout cf327c2068549194a29160499c2ecafa9061e46e", BUILD)
        self.assertIn("- all", BUILD)
        self.assertEqual(BUILD.count("github.event.inputs.job == 'all'"), 6)

    def test_linux_artifact_contains_real_source_from_its_checkout(self):
        self.assertIn("rm -rf dist/lib/rustlib/src", BUILD)
        self.assertIn("mkdir -p dist/lib/rustlib/src/rust", BUILD)
        self.assertIn("cp -a library dist/lib/rustlib/src/rust/library", BUILD)

    def test_release_packages_library_relative_archive_without_reclone(self):
        self.assertNotIn("git clone --depth 1 -b compile_rustc_for_wasm17", RELEASE)
        self.assertIn('if [ ! -d "src/rust/library" ]; then', RELEASE)
        self.assertIn('--directory src/rust/library .', RELEASE)

    def test_release_uses_one_explicit_build_run(self):
        self.assertIn("build_run_id:", RELEASE)
        self.assertNotIn("gh run list --workflow rustc_llvm_with_lld.yml", RELEASE)
        self.assertIn('gh run download "${{ github.event.inputs.build_run_id }}"', RELEASE)


if __name__ == "__main__":
    unittest.main()
```

Create an empty `tests/__init__.py` so the test is importable as a module.

- [ ] **Step 2: Run the contract test to verify RED**

Run: `python3 -m unittest tests.test_release_rust_src_contract -v`

Expected: FAIL because `RUST_SOURCE_REF` and `job=all` do not exist, the jobs use repeated shell checkouts, release packaging reclones a mutable branch, and each release asset is selected from a separate latest run.

- [ ] **Step 3: Centralize the source ref and use it in every build job**

Add this workflow-level environment after `permissions` in `.github/workflows/rustc_llvm_with_lld.yml`:

```yaml
env:
  RUST_SOURCE_REF: cf327c2068549194a29160499c2ecafa9061e46e
```

For `install-abort`, `install-unwind`, `dist-linux`, `dist-macos`, and `dist-windows`, change the Rust checkout to:

```yaml
- name: copy source
  uses: actions/checkout@v4
  with:
    repository: 'oligamiq/rust'
    submodules: 'true'
    ref: ${{ env.RUST_SOURCE_REF }}
    path: 'rust'
```

Delete each immediately following shell step named `checkout` that fetches `compile_rustc_for_wasm16_cargo` and runs `git checkout cf327c...`.

- [ ] **Step 4: Make one workflow run produce the complete Rust artifact set**

Add `all` to the workflow dispatch `job` choices. Extend the conditions for `install-abort`, `install-unwind`, `merge-bins`, `dist-linux`, `dist-macos`, and `dist-windows` with:

```yaml
github.event.inputs.job == 'all'
```

Keep the existing single-job choices for targeted rebuilds. The new `all` choice is the release-producing path.

- [ ] **Step 5: Make release packaging consume one explicit build run**

Add this required input to `.github/workflows/create_release.yml`:

```yaml
      build_run_id:
        description: 'successful rustc_llvm_with_lld run containing the complete artifact set'
        required: true
```

For `linux`, `windows`, `macos`, and `rustc-bins`, replace the loop over the ten latest workflow runs with one download from the supplied run:

```bash
gh run download "${{ github.event.inputs.build_run_id }}" \
  --name "$ARTIFACT_NAME" \
  --dir "artifacts/${ARTIFACT_NAME}"
```

Keep the independent `build_llvm.yml` lookup for `llvm-bins`; LLVM source provenance is outside the Rust sysroot invariant.

- [ ] **Step 6: Put a real library source tree into `dist-linux`**

Extend the `dist-linux` `build dist` step immediately after the existing `rsync` and host-bin removal:

```yaml
          rm -rf dist/lib/rustlib/src
          mkdir -p dist/lib/rustlib/src/rust
          cp -a library dist/lib/rustlib/src/rust/library
```

This copy comes from the exact checkout that produced the target libraries in the same job. It also prevents the artifact from retaining a build-machine symlink.

- [ ] **Step 7: Package a library-relative rust-src release asset**

Replace `.github/workflows/create_release.yml`'s clone-and-copy block under `matrix.task == linux` with:

```yaml
              # Package rust-src with the layout consumed by Rubrc.
              if [ ! -d "src/rust/library" ]; then
                echo "dist-linux artifact is missing src/rust/library"
                exit 1
              fi
              tar -czf "${{ github.workspace }}/x-tools/rust-src.tar.gz" \
                --directory src/rust/library .
              tar -I "brotli -q 11" \
                -cf "${{ github.workspace }}/x-tools/rust-src.tar.br" \
                --directory src/rust/library .
              echo "rust-src done"
```

Keep target-specific library packaging unchanged. It already excludes `src` and `rustc-src`.

- [ ] **Step 8: Run workflow contract and syntax checks**

Run: `python3 -m unittest tests.test_release_rust_src_contract -v`

Expected: PASS, 4 tests.

Run: `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 .github/workflows/rustc_llvm_with_lld.yml .github/workflows/create_release.yml`

Expected: no diagnostics.

- [ ] **Step 9: Commit the producer change**

```bash
git add tests/__init__.py tests/test_release_rust_src_contract.py .github/workflows/rustc_llvm_with_lld.yml .github/workflows/create_release.yml
git commit -m "feat: publish matching rust-src artifact"
```

---

### Task 2: Publish and Validate the v0.2.1 Artifact Set

**Working directory:** `/home/oligami/projects/rust_wasm`

**Files:**
- No source files change in this task.

**Interfaces:**
- Consumes: Task 1's committed workflows.
- Produces: reachable `v0.2.1/rust-src.tar.br`, `v0.2.1/wasm32-wasip1.tar.br`, and existing additional-target assets on GitHub Pages.

- [ ] **Step 1: Obtain explicit authorization before pushing**

The workflows cannot run from the local-only commit. Ask the user to authorize pushing the Task 1 commit to `origin/main`. Do not push without that authorization.

- [ ] **Step 2: Push the producer commit**

Run: `git push origin main`

Expected: the Task 1 commit is accepted without force-push.

- [ ] **Step 3: Build one complete Rust artifact set**

Run: `gh workflow run rustc_llvm_with_lld.yml --ref main -f job=all`

Run: `gh run watch "$(gh run list --workflow rustc_llvm_with_lld.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`

Expected: the run succeeds and uploads `dist-linux`, `dist-macos`, `dist-windows`, and `rustc-bins` from the single pinned source ref.

- [ ] **Step 4: Create the v0.2.1 release**

Run:

```bash
BUILD_RUN_ID="$(gh run list --workflow rustc_llvm_with_lld.yml --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
gh workflow run create_release.yml --ref main -f version=v0.2.1 -f build_run_id="$BUILD_RUN_ID"
```

Run: `gh run watch "$(gh run list --workflow create_release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`

Expected: release `v0.2.1-release` contains `rust-src.tar.br` and the target archives.

- [ ] **Step 5: Wait for Pages deployment and verify archive structure**

Run: `gh run watch "$(gh run list --workflow deploy_pages.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`

Run:

```bash
curl --fail --silent --show-error "https://oligamiq.github.io/rust_wasm/v0.2.1/rust-src.tar.br" \
  | brotli --decompress \
  | tar --list --file - core/src/lib.rs alloc/src/lib.rs std/src/lib.rs
```

Expected output contains exactly the three requested paths and exits zero. This is a structure check, not a commit-hash or digest check.

---

### Task 3: Source Rubrc Assets From One rust_wasm Release

**Working directory:** `/home/oligami/projects/rubrc`

**Files:**
- Create: `lib/src/rust_wasm_release.ts`
- Create: `lib/src/rust_wasm_release_test.ts`
- Modify: `page/src/sysroot_archive.ts:38-61`
- Modify: `page/src/sysroot_archive_test.ts:13-46`
- Modify: `scripts/sysroot_cache.ts:36-115,150-180`
- Modify: `scripts/sysroot_cache_test.ts:1-80`
- Replace implementation: `scripts/rust_src_archive.ts`
- Replace tests: `scripts/rust_src_archive_test.ts:1-207`
- Modify: `scripts/prepare_rust_src_asset.ts:1-17`
- Modify: `scripts/prepare_rust_src_dev_asset.ts:1,100-105`
- Modify: `scripts/vfs_lsp_diagnostics_test.ts:1-60`
- Modify: `package.json:27-28`

**Interfaces:**
- Produces: `rustWasmReleaseArchiveUrl(name: string): string`.
- Produces: `prepareReleasedRustSrcArchive(options?: ReleasedRustSrcArchiveOptions): Promise<{ archive: Uint8Array; cacheArchive: string; source: "cache" | "download" }>`.
- Consumes: Task 2's `v0.2.1` Pages assets.
- Preserves: same-origin browser URL `rust-src.tar.vfsbr?v=<rubrc revision>&build=<epoch>` after build-time copying.

- [ ] **Step 1: Write failing shared-release URL tests**

```ts
// lib/src/rust_wasm_release_test.ts
import {
  RUST_WASM_RELEASE_BASE_URL,
  rustWasmReleaseArchiveUrl,
} from "./rust_wasm_release.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Error(`${actual} !== ${expected}`);
};

Deno.test("rust_wasm archives share the pinned v0.2.1 release", () => {
  assertEquals(
    RUST_WASM_RELEASE_BASE_URL,
    "https://oligamiq.github.io/rust_wasm/v0.2.1",
  );
  assertEquals(
    rustWasmReleaseArchiveUrl("rust-src"),
    `${RUST_WASM_RELEASE_BASE_URL}/rust-src.tar.br`,
  );
  assertEquals(
    rustWasmReleaseArchiveUrl("wasm32-wasip1"),
    `${RUST_WASM_RELEASE_BASE_URL}/wasm32-wasip1.tar.br`,
  );
});
```

Update `page/src/sysroot_archive_test.ts` to expect target URLs below `v0.2.1` while still expecting rust-src to use the same-origin built asset.

- [ ] **Step 2: Run URL tests to verify RED**

Run: `deno test lib/src/rust_wasm_release_test.ts page/src/sysroot_archive_test.ts`

Expected: FAIL because the shared module is absent and browser target URLs still use `v0.2.0`.

- [ ] **Step 3: Add the shared release URL and switch target consumers**

```ts
// lib/src/rust_wasm_release.ts
export const RUST_WASM_RELEASE_BASE_URL =
  "https://oligamiq.github.io/rust_wasm/v0.2.1";

export function rustWasmReleaseArchiveUrl(name: string): string {
  return `${RUST_WASM_RELEASE_BASE_URL}/${name}.tar.br`;
}
```

Import `rustWasmReleaseArchiveUrl` in `page/src/sysroot_archive.ts` and use it for non-rust-src triples. Import it in `scripts/sysroot_cache.ts` and replace both `DEFAULT_BASE_URL` interpolations. Do not change the browser's same-origin rust-src URL or cache query parameters.

- [ ] **Step 4: Write failing released-rust-src preparation tests**

Replace the installed-toolchain cases in `scripts/rust_src_archive_test.ts` with injected tests that assert:

```ts
Deno.test("released rust-src preparation uses the pinned release and validates bytes", async () => {
  const calls: unknown[] = [];
  const archive = new Uint8Array([7]);
  const result = await prepareReleasedRustSrcArchive({
    deps: {
      prepare: async (options) => {
        calls.push(options);
        return {
          archive,
          source: "download",
          cacheArchive: ".cache/rust-src.tar.br",
          url: rustWasmReleaseArchiveUrl("rust-src"),
        };
      },
      validate: async (bytes) => bytes === archive,
      remove: async () => {
        throw new Error("valid archive was removed");
      },
    },
  });
  if (result.archive !== archive || result.source !== "download") {
    throw new Error("released archive was not returned");
  }
  const options = calls[0] as { triple: string; url: string };
  if (
    options.triple !== "rust-src" ||
    options.url !== rustWasmReleaseArchiveUrl("rust-src")
  ) throw new Error(`wrong release request: ${JSON.stringify(options)}`);
});

Deno.test("invalid released rust-src is removed from cache", async () => {
  let removed = "";
  await prepareReleasedRustSrcArchive({
    deps: {
      prepare: async () => ({
        archive: new Uint8Array([9]),
        source: "cache",
        cacheArchive: ".cache/rust-src.tar.br",
        url: rustWasmReleaseArchiveUrl("rust-src"),
      }),
      validate: async () => false,
      remove: async (path) => {
        removed = path;
      },
    },
  }).then(
    () => {
      throw new Error("invalid released rust-src was accepted");
    },
    (error) => {
      if (!(error instanceof Error) || !error.message.includes("invalid")) {
        throw error;
      }
    },
  );
  if (removed !== ".cache/rust-src.tar.br") {
    throw new Error(`invalid cache was not removed: ${removed}`);
  }
});
```

Keep the existing `writeRustSrcAsset` byte-copy test, updating its injected source value from `"generated"` to `"download"`.

- [ ] **Step 5: Run rust-src preparation tests to verify RED**

Run: `deno test scripts/rust_src_archive_test.ts scripts/sysroot_cache_test.ts`

Expected: FAIL because `prepareReleasedRustSrcArchive` does not exist and installed-toolchain identity helpers still define the old behavior.

- [ ] **Step 6: Implement release-backed preparation and remove installed-toolchain generation**

Replace `scripts/rust_src_archive.ts` with:

```ts
import { rustWasmReleaseArchiveUrl } from "../lib/src/rust_wasm_release.ts";
import {
  prepareCachedArchive,
  type SysrootCacheSource,
  validateRustSrcArchive,
} from "./sysroot_cache.ts";

type PreparedArchive = {
  archive: Uint8Array;
  source: SysrootCacheSource;
  cacheArchive: string;
  url: string;
};

export type ReleasedRustSrcArchiveDeps = {
  prepare(options: {
    triple: string;
    cacheDir?: string;
    url: string;
  }): Promise<PreparedArchive>;
  validate(archive: Uint8Array): Promise<boolean>;
  remove(path: string): Promise<void>;
};

export type ReleasedRustSrcArchiveOptions = {
  cacheDir?: string;
  deps?: ReleasedRustSrcArchiveDeps;
};

const defaultDeps: ReleasedRustSrcArchiveDeps = {
  prepare: (options) => prepareCachedArchive(options),
  validate: validateRustSrcArchive,
  remove: async (path) => {
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
};

export async function prepareReleasedRustSrcArchive(
  options: ReleasedRustSrcArchiveOptions = {},
): Promise<Omit<PreparedArchive, "url">> {
  const deps = options.deps ?? defaultDeps;
  const prepared = await deps.prepare({
    triple: "rust-src",
    cacheDir: options.cacheDir,
    url: rustWasmReleaseArchiveUrl("rust-src"),
  });
  if (!(await deps.validate(prepared.archive))) {
    await deps.remove(prepared.cacheArchive);
    throw new Error("released rust-src archive is invalid");
  }
  return {
    archive: prepared.archive,
    cacheArchive: prepared.cacheArchive,
    source: prepared.source,
  };
}
```

Delete now-unused installed-toolchain helpers and tests from `scripts/sysroot_cache.ts` and `scripts/sysroot_cache_test.ts`: `rustSrcToolchainIdentity`, `rustSrcCacheMatchesIdentity`, `createRustSrcCacheMetadata`, `rustSrcCacheMatchesMetadata`, and `deterministicRustSrcTarArgs`. Keep `validateRustSrcArchive` and its required-entry/path-safety tests.

Update `prepare_rust_src_asset.ts`, `prepare_rust_src_dev_asset.ts`, and `vfs_lsp_diagnostics_test.ts` to import and call `prepareReleasedRustSrcArchive`. Update injected result types to `source: "cache" | "download"`.

Change the two root package scripts to use network permission instead of subprocess permission:

```json
"rust-src:prepare-asset": "deno run --no-lock --allow-read --allow-write --allow-net scripts/prepare_rust_src_asset.ts",
"rust-src:prepare-dev-asset": "deno run --no-lock --allow-read --allow-write --allow-net scripts/prepare_rust_src_dev_asset.ts"
```

- [ ] **Step 7: Run focused asset tests to verify GREEN**

Run:

```bash
deno test scripts/sysroot_cache_test.ts scripts/rust_src_archive_test.ts scripts/rust_src_dev_asset_test.ts page/src/sysroot_archive_test.ts lib/src/rust_wasm_release_test.ts
```

Expected: PASS.

- [ ] **Step 8: Exercise real release download and production asset writing**

Run: `npm run rust-src:prepare-asset`

Expected: reports `wrote validated rust-src asset to page/dist/rust-src.tar.vfsbr`; no `rustc` or `tar` subprocess is required.

- [ ] **Step 9: Commit the Rubrc artifact-source change**

```bash
git add lib/src/rust_wasm_release.ts lib/src/rust_wasm_release_test.ts page/src/sysroot_archive.ts page/src/sysroot_archive_test.ts scripts/sysroot_cache.ts scripts/sysroot_cache_test.ts scripts/rust_src_archive.ts scripts/rust_src_archive_test.ts scripts/prepare_rust_src_asset.ts scripts/prepare_rust_src_dev_asset.ts scripts/vfs_lsp_diagnostics_test.ts package.json
git commit -m "feat: source rust-src from toolchain release"
```

---

### Task 4: Let rust-analyzer Discover the Standard Library

**Working directory:** `/home/oligami/projects/rubrc`

**Files:**
- Modify: `page/src/rust_lsp_config_test.ts:31-70`
- Modify: `page/src/rust_lsp_config.ts:17-35,45-70`

**Interfaces:**
- Produces: `createRustAnalyzerProjectSettings()` without `sysroot_project`.
- Preserves: `sysroot`, `sysroot_src`, `rubrc-main`, Cargo autoreload, disabled build scripts/proc macros/check-on-save/cache priming.

- [ ] **Step 1: Change the exact-shape test to require automatic discovery**

Remove `sysroot_project` from the expected object in `rust_lsp_config_test.ts`. Add this explicit guard after obtaining the full settings:

```ts
const project = createRustAnalyzerProjectSettings().linkedProjects[0] as
  & Record<string, unknown>
  & { sysroot_src: string };
if ("sysroot_project" in project) {
  throw new Error("full project still overrides rust-analyzer sysroot discovery");
}
if (project.sysroot_src !== "/sysroot/lib/rustlib/src/rust/library") {
  throw new Error("full project lost the installed rust-src root");
}
```

- [ ] **Step 2: Run the config test to verify RED**

Run: `deno test page/src/rust_lsp_config_test.ts`

Expected: FAIL because the returned linked project still contains the synthetic core-only `sysroot_project`.

- [ ] **Step 3: Remove the custom graph override**

Delete `sysroot_project` from both the return type and object literal in `createRustAnalyzerProjectSettings()`. Keep this linked-project shape:

```ts
{
  sysroot: "/sysroot",
  sysroot_src: "/sysroot/lib/rustlib/src/rust/library",
  crates: [
    {
      display_name: "rubrc-main",
      root_module: "/src/main.rs",
      edition: "2021",
      deps: [],
    },
  ],
}
```

- [ ] **Step 4: Run the config tests to verify GREEN**

Run: `deno test page/src/rust_lsp_config_test.ts page/src/rust_lsp_client_runtime_test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the graph configuration change**

```bash
git add page/src/rust_lsp_config.ts page/src/rust_lsp_config_test.ts
git commit -m "feat: enable rust-analyzer sysroot discovery"
```

---

### Task 5: Require core, alloc, and std Before Semantic Readiness

**Working directory:** `/home/oligami/projects/rubrc`

**Files:**
- Modify: `page/src/rust_analyzer_readiness_test.ts:7-110` and all later ready graph fixtures
- Modify: `page/src/rust_analyzer_readiness.ts:130-158`

**Interfaces:**
- Produces: crate graph readiness requiring exact node labels `rubrc_main`, `core`, `alloc`, and `std`.
- Preserves: full-graph request `{ full: true }`, ContentModified retries, timeout, abort, and semantic version barriers.

- [ ] **Step 1: Extend the readiness fixtures and failing tests**

Add fixtures:

```ts
const allocNode = '  _2 [label="alloc"];';
const stdNode = '  _3 [label="std"];';
const readyNodes = `${mainNode}\n${coreNode}\n${allocNode}\n${stdNode}`;
```

Rename the polling test to `crate graph polling requires main, core, alloc, and std in the full graph`, and make its responses omit one required node at each step before returning `graph(readyNodes)`. Extend the exact-label test with near misses for `alloc2` and `std2`.

Replace every later two-node ready graph fixture with `graph(readyNodes)` so unrelated semantic, timeout, and disposal tests reach their intended phase.

- [ ] **Step 2: Run readiness tests to verify RED**

Run: `deno test page/src/rust_analyzer_readiness_test.ts`

Expected: FAIL because readiness still accepts a graph without `alloc` and `std`.

- [ ] **Step 3: Strengthen the production predicate**

Change `crateGraphIsReady` to:

```ts
const crateGraphIsReady = (dot: unknown) => {
  if (typeof dot !== "string") return false;
  const labels = nodeLabels(dot);
  return ["rubrc_main", "core", "alloc", "std"].every((label) =>
    labels.has(label)
  );
};
```

- [ ] **Step 4: Run readiness and startup tests to verify GREEN**

Run:

```bash
deno test page/src/rust_analyzer_readiness_test.ts page/src/rust_lsp_startup_test.ts page/src/startup_coordinator_test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the readiness change**

```bash
git add page/src/rust_analyzer_readiness.ts page/src/rust_analyzer_readiness_test.ts
git commit -m "feat: wait for standard library crate graph"
```

---

### Task 6: Expose Completion and Definition Requests to Browser Tests

**Working directory:** `/home/oligami/projects/rubrc`

**Files:**
- Modify: `page/src/lsp_test_api_state.ts:32-59,98-125`
- Modify: `page/src/lsp_test_api.ts:26-34,395-438`
- Modify: `page/src/rust_lsp_client.ts:20-28,166-170`
- Modify: `page/src/rust_lsp_client_test.ts:1-10,360-400,1204-1304`
- Modify: `page/src/lsp_test_api_state_test.ts:1-220`

**Interfaces:**
- Produces on test builds only:
  - `requestCompletion(uri: string, position: { line: number; character: number }): Promise<unknown>`
  - `requestDefinition(uri: string, position: { line: number; character: number }): Promise<unknown>`
- Renames internal helpers to `installAnalyzerTestRequests`, `installGenerationAnalyzerTestRequests`, and `exposeAnalyzerTestRequests`.
- Preserves: `requestSyntaxTree` and `requestCrateGraph` behavior and generation-safe disposal.

- [ ] **Step 1: Extend failing callback and disposal tests**

Update the existing syntax-tree callback test state to include completion and definition callbacks. Invoke them and assert the exact LSP calls:

```ts
await state.requestCompletion?.("file:///src/main.rs", { line: 2, character: 7 });
await state.requestDefinition?.("file:///src/main.rs", { line: 3, character: 9 });

assert(
  JSON.stringify(requests.at(-2)) === JSON.stringify({
    method: "textDocument/completion",
    params: {
      textDocument: { uri: "file:///src/main.rs" },
      position: { line: 2, character: 7 },
    },
  }),
  "completion request used the wrong parameters",
);
assert(
  JSON.stringify(requests.at(-1)) === JSON.stringify({
    method: "textDocument/definition",
    params: {
      textDocument: { uri: "file:///src/main.rs" },
      position: { line: 3, character: 9 },
    },
  }),
  "definition request used the wrong parameters",
);
```

Extend owner disposal, stale-generation installation, and new-generation replacement assertions to cover all four callbacks. Extend `beginLspTestGeneration` reset tests so stale completion/definition callbacks are deleted.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `deno test page/src/rust_lsp_client_test.ts page/src/lsp_test_api_state_test.ts`

Expected: FAIL because completion and definition callbacks are absent.

- [ ] **Step 3: Add generation-safe semantic request wrappers**

Extend `LspTestGenerationState` with:

```ts
requestCompletion?: (
  uri: string,
  position: { line: number; character: number },
) => Promise<unknown>;
requestDefinition?: (
  uri: string,
  position: { line: number; character: number },
) => Promise<unknown>;
```

Rename the existing syntax-tree installer family to the analyzer-request names listed in **Interfaces**, then add:

```ts
const requestCompletion = (
  uri: string,
  position: { line: number; character: number },
) =>
  client.sendRequest("textDocument/completion", {
    textDocument: { uri },
    position,
  });
const requestDefinition = (
  uri: string,
  position: { line: number; character: number },
) =>
  client.sendRequest("textDocument/definition", {
    textDocument: { uri },
    position,
  });
```

Install all four callbacks together. Disposal must use identity checks for each callback before deleting it. `beginLspTestGeneration` must delete all four stale callbacks. Update `rust_lsp_client.ts` to resource-own `exposeAnalyzerTestRequests(testGeneration, client)`.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `deno test page/src/rust_lsp_client_test.ts page/src/lsp_test_api_state_test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the browser test API change**

```bash
git add page/src/lsp_test_api_state.ts page/src/lsp_test_api.ts page/src/rust_lsp_client.ts page/src/rust_lsp_client_test.ts page/src/lsp_test_api_state_test.ts
git commit -m "test: expose rust semantic requests"
```

---

### Task 7: Verify Practical std Analysis in the Real Browser

**Working directory:** `/home/oligami/projects/rubrc`

**Files:**
- Modify: `scripts/lsp_browser_diagnostics_test.mjs:17-24,453-634`
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts`

**Interfaces:**
- Consumes: Task 6's `window.__rubrcLspTest.requestCompletion` and `requestDefinition`.
- Verifies: `rubrc_main`, `core`, `alloc`, and `std` graph nodes; `std::env` completion; definition below `/sysroot/lib/rustlib/src/rust/library/std/`; std-specific diagnostics and clearing.

- [ ] **Step 1: Extend the browser contract test first**

In `lsp_browser_diagnostics_contract_test.ts`, require the browser script source to contain:

```ts
for (const required of [
  'nodeLabel("alloc")',
  'nodeLabel("std")',
  "requestCompletion",
  "requestDefinition",
  "definitely_missing",
  "/sysroot/lib/rustlib/src/rust/library/std/",
]) {
  assert(source.includes(required), `browser std-analysis contract missing ${required}`);
}
```

- [ ] **Step 2: Run the browser contract test to verify RED**

Run: `deno test scripts/lsp_browser_diagnostics_contract_test.ts`

Expected: FAIL because the existing browser script checks only `rubrc_main` and `core` and does not request completion or definition.

- [ ] **Step 3: Require all public sysroot graph nodes in the E2E**

Change the startup graph assertion to require:

```js
if (
  !nodeLabel("rubrc_main") ||
  !nodeLabel("core") ||
  !nodeLabel("alloc") ||
  !nodeLabel("std")
) {
  throw new Error(
    "crate graph is missing rubrc-main, core, alloc, or std nodes",
  );
}
```

- [ ] **Step 4: Add std completion and definition checks**

Add these source constants near the existing main fixtures:

```js
const completionMain = "fn main() { let _ = std::env::curr; }\n";
const validStdMain = "fn main() { let _ = std::env::current_dir(); }\n";
const invalidStdMain =
  "fn main() { let _ = std::env::definitely_missing(); }\n";
```

After startup graph validation, settle the completion document change with:

```js
const beforeCompletionPublication = await page.evaluate(
  () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
);
await page.evaluate((text) => {
  window.__rubrcLspTest.model.setValue(text);
}, completionMain);
await page.waitForFunction(
  (previous) =>
    window.__rubrcLspTest.mainDiagnosticsPublicationCount > previous,
  { timeout: remainingAnalysisBudget() },
  beforeCompletionPublication,
);
```

Then call:

```js
const completion = await page.evaluate(async () => {
  const api = window.__rubrcLspTest;
  const result = await api.requestCompletion(
    "file:///src/main.rs",
    { line: 0, character: "fn main() { let _ = std::env::curr".length },
  );
  const items = Array.isArray(result) ? result : result?.items ?? [];
  return items.map((item) => item.label);
});
if (!completion.includes("current_dir")) {
  throw new Error(`std completion omitted current_dir: ${completion.join(",")}`);
}
```

Set `validStdMain`, record the publication counter first, then call `waitForDiagnosticsQuiescence` with this complete barrier before requesting a definition:

```js
const beforeValidStdPublication = await page.evaluate(
  () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
);
await page.evaluate((text) => {
  window.__rubrcLspTest.model.setValue(text);
}, validStdMain);
await waitForDiagnosticsQuiescence({
  stage: "valid std definition",
  waitForPublication: () =>
    page.waitForFunction(
      (previous) =>
        window.__rubrcLspTest.mainDiagnosticsPublicationCount > previous,
      { timeout: remainingAnalysisBudget() },
      beforeValidStdPublication,
    ),
  waitForMarkers: () =>
    page.waitForFunction(
      () => {
        const { monaco } = window.__rubrcLspTest;
        const uri = monaco.Uri.parse("file:///src/main.rs");
        return !monaco.editor
          .getModelMarkers({ resource: uri })
          .some((marker) => marker.severity === monaco.MarkerSeverity.Error);
      },
      { timeout: remainingAnalysisBudget() },
    ),
  requestSyntaxTree: () =>
    page.evaluate(() =>
      window.__rubrcLspTest.requestSyntaxTree("file:///src/main.rs")
    ),
  timeoutMs: remainingAnalysisBudget(),
});
```

Request a definition at a position inside `current_dir`:

```js
const definitionUris = await page.evaluate(async () => {
  const api = window.__rubrcLspTest;
  const result = await api.requestDefinition(
    "file:///src/main.rs",
    { line: 0, character: "fn main() { let _ = std::env::current".length },
  );
  const values = result == null ? [] : Array.isArray(result) ? result : [result];
  return values.map((value) => value.uri ?? value.targetUri ?? "");
});
if (
  !definitionUris.some((uri) =>
    uri.includes("/sysroot/lib/rustlib/src/rust/library/std/")
  )
) {
  throw new Error(`std definition resolved outside rust-src: ${definitionUris}`);
}
```

- [ ] **Step 5: Add std-specific diagnostics and clearing**

Set `invalidStdMain` and use this exact quiescence barrier:

```js
const beforeInvalidStdPublication = await page.evaluate(
  () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
);
await page.evaluate((text) => {
  window.__rubrcLspTest.model.setValue(text);
}, invalidStdMain);
await waitForDiagnosticsQuiescence({
  stage: "invalid std diagnostics",
  waitForPublication: () =>
    page.waitForFunction(
      (previous) =>
        window.__rubrcLspTest.mainDiagnosticsPublicationCount > previous,
      { timeout: remainingAnalysisBudget() },
      beforeInvalidStdPublication,
    ),
  waitForMarkers: () =>
    page.waitForFunction(
      () => {
        const { monaco } = window.__rubrcLspTest;
        const uri = monaco.Uri.parse("file:///src/main.rs");
        return monaco.editor
          .getModelMarkers({ resource: uri })
          .some((marker) =>
            marker.severity === monaco.MarkerSeverity.Error &&
            marker.source === "rust-analyzer" &&
            marker.message.includes("definitely_missing")
          );
      },
      { timeout: remainingAnalysisBudget() },
    ),
  requestSyntaxTree: () =>
    page.evaluate(() =>
      window.__rubrcLspTest.requestSyntaxTree("file:///src/main.rs")
    ),
  timeoutMs: remainingAnalysisBudget(),
});
```

Clear the std diagnostic with:

```js
const beforeStdClearPublication = await page.evaluate(
  () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
);
await page.evaluate((text) => {
  window.__rubrcLspTest.model.setValue(text);
}, validStdMain);
await waitForDiagnosticsQuiescence({
  stage: "clearing std diagnostics",
  waitForPublication: () =>
    page.waitForFunction(
      (previous) =>
        window.__rubrcLspTest.mainDiagnosticsPublicationCount > previous,
      { timeout: remainingAnalysisBudget() },
      beforeStdClearPublication,
    ),
  waitForMarkers: () =>
    page.waitForFunction(
      () => {
        const { monaco } = window.__rubrcLspTest;
        const uri = monaco.Uri.parse("file:///src/main.rs");
        return !monaco.editor
          .getModelMarkers({ resource: uri })
          .some((marker) => marker.severity === monaco.MarkerSeverity.Error);
      },
      { timeout: remainingAnalysisBudget() },
    ),
  requestSyntaxTree: () =>
    page.evaluate(() =>
      window.__rubrcLspTest.requestSyntaxTree("file:///src/main.rs")
    ),
  timeoutMs: remainingAnalysisBudget(),
});
```

Do not sleep for arbitrary durations.

Keep the existing type-mismatch diagnostics test, secondary-file test, target loading, remount, and lifecycle assertions unchanged.

- [ ] **Step 6: Run static browser contract to verify GREEN**

Run: `deno test scripts/lsp_browser_diagnostics_contract_test.ts`

Expected: PASS.

- [ ] **Step 7: Run the real browser acceptance test**

Run: `npm run test:lsp-browser`

Expected: PASS within the existing startup and analysis budgets. The log must show normal phase ordering, and the test must observe std completion, a std source definition, an invalid std API diagnostic, and diagnostic clearing.

- [ ] **Step 8: Commit the E2E coverage**

```bash
git add scripts/lsp_browser_diagnostics_test.mjs scripts/lsp_browser_diagnostics_contract_test.ts
git commit -m "test: verify browser rust-std analysis"
```

---

### Task 8: Final Cross-Repository Verification

**Working directories:** `/home/oligami/projects/rust_wasm` and `/home/oligami/projects/rubrc`

**Files:**
- No source files should change in this task.

**Interfaces:**
- Verifies the complete producer-to-browser path and guards against unrelated regressions.

- [ ] **Step 1: Verify rust_wasm workflow contracts**

Run in `/home/oligami/projects/rust_wasm`:

```bash
python3 -m unittest tests.test_release_rust_src_contract -v
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 .github/workflows/rustc_llvm_with_lld.yml .github/workflows/create_release.yml
git diff --check
```

Expected: all tests pass, actionlint emits no diagnostics, and `git diff --check` is silent.

- [ ] **Step 2: Verify all focused Rubrc tests together**

Run in `/home/oligami/projects/rubrc`:

```bash
deno test lib/src/rust_wasm_release_test.ts scripts/sysroot_cache_test.ts scripts/rust_src_archive_test.ts scripts/rust_src_dev_asset_test.ts page/src/sysroot_archive_test.ts page/src/rust_lsp_config_test.ts page/src/rust_analyzer_readiness_test.ts page/src/lsp_test_api_state_test.ts page/src/rust_lsp_client_test.ts page/src/rust_lsp_client_runtime_test.ts page/src/rust_lsp_startup_test.ts page/src/startup_coordinator_test.ts scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: PASS.

- [ ] **Step 3: Verify production build and browser behavior from a clean asset write**

Run in `/home/oligami/projects/rubrc`:

```bash
npm run rust-src:prepare-asset
npm run test:lsp-browser
git diff --check
```

Expected: asset preparation and the browser acceptance test pass; `git diff --check` is silent.

- [ ] **Step 4: Inspect repository state without touching unrelated files**

Run in each repository: `git status --short --branch`

Expected: only intentionally created commits and pre-existing unrelated untracked files are present. Do not stage, delete, or modify the existing unrelated files in either worktree.
