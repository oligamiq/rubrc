import {
  createRustSrcCacheMetadata,
  deterministicRustSrcTarArgs,
  prepareCachedArchive,
  prepareCachedSysroot,
  rustSrcCacheMatchesIdentity,
  rustSrcCacheMatchesMetadata,
  rustSrcToolchainIdentity,
  type SysrootCacheDeps,
  sysrootCachePaths,
  validateRustSrcArchive,
  validateTarEntryName,
} from "./sysroot_cache.ts";

Deno.test("rust-src cache identity includes exact compiler and sysroot", () => {
  const identity = rustSrcToolchainIdentity(
    "rustc 1.95.0-nightly\ncommit-hash: abc123\n",
    "/toolchains/nightly",
  );
  if (!rustSrcCacheMatchesIdentity(identity, `${identity}\n`)) {
    throw new Error("matching identity was rejected");
  }
  if (
    rustSrcCacheMatchesIdentity(
      identity,
      rustSrcToolchainIdentity(
        "rustc 1.95.0-nightly\ncommit-hash: def456",
        "/toolchains/nightly",
      ),
    )
  ) {
    throw new Error("different compiler identity was reused");
  }
  if (
    rustSrcCacheMatchesIdentity(
      identity,
      rustSrcToolchainIdentity(
        "rustc 1.95.0-nightly\ncommit-hash: abc123",
        "/other",
      ),
    )
  ) {
    throw new Error("different sysroot identity was reused");
  }
});

Deno.test("rust-src cache metadata rejects an archive digest mismatch", async () => {
  const identity = rustSrcToolchainIdentity("rustc exact", "/exact/sysroot");
  const original = new Uint8Array([1, 2, 3]);
  const metadata = await createRustSrcCacheMetadata(identity, original);
  if (!await rustSrcCacheMatchesMetadata(identity, original, metadata)) {
    throw new Error("matching cache metadata was rejected");
  }
  if (
    await rustSrcCacheMatchesMetadata(
      identity,
      new Uint8Array([1, 2, 4]),
      metadata,
    )
  ) {
    throw new Error("digest-mismatched archive was accepted");
  }
});

Deno.test("rust-src tar arguments fix ordering and metadata", () => {
  const args = deterministicRustSrcTarArgs("/toolchain/library");
  const expected = [
    "--create",
    "--file",
    "-",
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=u+rwX,go+rX,go-w",
    "--pax-option=delete=atime,delete=ctime",
    "--directory",
    "/toolchain/library",
    ".",
  ];
  if (args.join("\n") !== expected.join("\n")) {
    throw new Error(
      `unexpected deterministic tar arguments:\n${args.join("\n")}`,
    );
  }
});

Deno.test("rust-src archive validation requires complete safe crate roots", async () => {
  const archive = new Uint8Array([7]);
  const complete = [
    "./core/src/lib.rs",
    "./alloc/src/lib.rs",
    "./std/src/lib.rs",
    "./std/src/sys/pal/unix/mod.rs",
  ];
  if (!await validateRustSrcArchive(archive, async () => complete)) {
    throw new Error("complete rust-src archive was rejected");
  }

  for (const required of complete.slice(0, 3)) {
    const missing = complete.filter((entry) => entry !== required);
    if (await validateRustSrcArchive(archive, async () => missing)) {
      throw new Error(`archive missing ${required} was accepted`);
    }
  }

  if (
    await validateRustSrcArchive(
      archive,
      async () => [...complete, "../../escape"],
    )
  ) {
    throw new Error("archive with unsafe path was accepted");
  }
});

Deno.test("prepareCachedArchive caches rust-src without target layout", async () => {
  const calls: string[] = [];
  const result = await prepareCachedArchive({
    triple: "rust-src",
    cacheDir: ".cache/sysroot",
    deps: {
      exists: async () => false,
      remove: async () => {},
      mkdir: async (path) => {
        calls.push(`mkdir:${path}`);
      },
      readFile: async () => new Uint8Array(),
      writeFile: async (path) => {
        calls.push(`write:${path}`);
      },
      rename: async (from, to) => {
        calls.push(`rename:${from}:${to}`);
      },
      fetchBytes: async () => new Uint8Array([7]),
      extractTarBr: async () => {
        throw new Error("must not extract");
      },
    },
  });
  if (result.cacheArchive !== ".cache/sysroot/rust-src.tar.br") {
    throw new Error("wrong cache path");
  }
  if (result.archive[0] !== 7) throw new Error("wrong archive bytes");
  if (calls.some((call) => call.startsWith("extract:"))) {
    throw new Error("archive was extracted");
  }
});

Deno.test("prepareCachedArchive uses unique temporary paths per invocation", async () => {
  const writes: string[] = [];
  const removals: string[] = [];
  const deps: SysrootCacheDeps = {
    exists: async () => false,
    remove: async (path) => {
      removals.push(path);
    },
    mkdir: async () => {},
    readFile: async () => new Uint8Array(),
    writeFile: async (path) => {
      writes.push(path);
    },
    rename: async () => {},
    fetchBytes: async () => new Uint8Array([7]),
    extractTarBr: async () => {},
  };

  await Promise.all([
    prepareCachedArchive({ triple: "rust-src", cacheDir: ".cache", deps }),
    prepareCachedArchive({ triple: "rust-src", cacheDir: ".cache", deps }),
  ]);

  if (writes.length !== 2 || writes[0] === writes[1]) {
    throw new Error(
      `temporary cache paths were not unique: ${writes.join(",")}`,
    );
  }
  if (writes.some((path) => path === ".cache/rust-src.tar.br.tmp")) {
    throw new Error("generic cache used the shared hardcoded temporary path");
  }
  for (const path of writes) {
    if (!removals.includes(path)) {
      throw new Error(`temporary cache path was not cleaned: ${path}`);
    }
  }
});

Deno.test("sysrootCachePaths uses repo-local cache and workspace paths", () => {
  const paths = sysrootCachePaths();

  if (paths.cacheArchive !== ".rubrc-cache/sysroot/wasm32-wasip1.tar.br") {
    throw new Error(`unexpected cache archive: ${paths.cacheArchive}`);
  }
  if (paths.expandedSysroot !== "test_workspace_rustc/sysroot") {
    throw new Error(`unexpected expanded sysroot: ${paths.expandedSysroot}`);
  }
  if (!paths.url.endsWith("/wasm32-wasip1.tar.br")) {
    throw new Error(`unexpected sysroot URL: ${paths.url}`);
  }
});

Deno.test("prepareCachedSysroot clears expanded sysroot and uses cached archive", async () => {
  const calls: string[] = [];
  const deps: SysrootCacheDeps = {
    async exists(path) {
      calls.push(`exists:${path}`);
      return path === ".cache/sysroot/wasm32-wasip1.tar.br";
    },
    async remove(path) {
      calls.push(`remove:${path}`);
    },
    async mkdir(path) {
      calls.push(`mkdir:${path}`);
    },
    async readFile(path) {
      calls.push(`read:${path}`);
      return new Uint8Array([1, 2, 3]);
    },
    async writeFile(path) {
      calls.push(`write:${path}`);
    },
    async rename(from, to) {
      calls.push(`rename:${from}:${to}`);
    },
    async fetchBytes(url) {
      calls.push(`fetch:${url}`);
      return new Uint8Array([4, 5, 6]);
    },
    async extractTarBr(data, destination) {
      calls.push(`extract:${destination}:${Array.from(data).join(",")}`);
    },
  };

  const result = await prepareCachedSysroot({
    cacheDir: ".cache/sysroot",
    workspaceSysroot: "workspace/sysroot",
    deps,
  });

  if (result.source !== "cache") {
    throw new Error(`expected cache source, got ${result.source}`);
  }
  if (calls.includes("fetch:https://example.invalid/sysroot.tar.br")) {
    throw new Error("did not expect fetch when cache exists");
  }
  const expected = [
    "remove:workspace/sysroot",
    "mkdir:.cache/sysroot",
    "exists:.cache/sysroot/wasm32-wasip1.tar.br",
    "read:.cache/sysroot/wasm32-wasip1.tar.br",
    "mkdir:workspace/sysroot/lib/rustlib/wasm32-wasip1/lib",
    "extract:workspace/sysroot/lib/rustlib/wasm32-wasip1/lib:1,2,3",
  ];
  if (calls.join("\n") !== expected.join("\n")) {
    throw new Error(`unexpected calls:\n${calls.join("\n")}`);
  }
});

Deno.test("prepareCachedSysroot downloads and writes cache when archive is missing", async () => {
  const calls: string[] = [];
  const deps: SysrootCacheDeps = {
    async exists(path) {
      calls.push(`exists:${path}`);
      return false;
    },
    async remove(path) {
      calls.push(`remove:${path}`);
    },
    async mkdir(path) {
      calls.push(`mkdir:${path}`);
    },
    async readFile(path) {
      calls.push(`read:${path}`);
      return new Uint8Array([1, 2, 3]);
    },
    async writeFile(path, data) {
      calls.push(`write:${path}:${Array.from(data).join(",")}`);
    },
    async rename(from, to) {
      calls.push(`rename:${from}:${to}`);
    },
    async fetchBytes(url) {
      calls.push(`fetch:${url}`);
      return new Uint8Array([9, 8, 7]);
    },
    async extractTarBr(data, destination) {
      calls.push(`extract:${destination}:${Array.from(data).join(",")}`);
    },
  };

  const result = await prepareCachedSysroot({
    cacheDir: ".cache/sysroot",
    workspaceSysroot: "workspace/sysroot",
    url: "https://example.invalid/sysroot.tar.br",
    deps,
  });

  if (result.source !== "download") {
    throw new Error(`expected download source, got ${result.source}`);
  }
  const prefix = [
    "remove:workspace/sysroot",
    "mkdir:.cache/sysroot",
    "exists:.cache/sysroot/wasm32-wasip1.tar.br",
    "fetch:https://example.invalid/sysroot.tar.br",
  ];
  if (calls.slice(0, prefix.length).join("\n") !== prefix.join("\n")) {
    throw new Error(`unexpected calls:\n${calls.join("\n")}`);
  }
  const write = calls[4];
  const temporary = write?.match(/^write:(.+):9,8,7$/)?.[1];
  if (
    !temporary || temporary === ".cache/sysroot/wasm32-wasip1.tar.br.tmp"
  ) {
    throw new Error(`cache temporary path was not unique: ${write}`);
  }
  const suffix = [
    `rename:${temporary}:.cache/sysroot/wasm32-wasip1.tar.br`,
    `remove:${temporary}`,
    "mkdir:workspace/sysroot/lib/rustlib/wasm32-wasip1/lib",
    "extract:workspace/sysroot/lib/rustlib/wasm32-wasip1/lib:9,8,7",
  ];
  if (calls.slice(5).join("\n") !== suffix.join("\n")) {
    throw new Error(`unexpected calls:\n${calls.join("\n")}`);
  }
});

Deno.test("validateTarEntryName rejects entries outside destination", () => {
  const invalid = ["../escape", "/absolute", "nested/../../escape"];
  for (const name of invalid) {
    let threw = false;
    try {
      validateTarEntryName(name);
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error(`expected ${name} to be rejected`);
    }
  }
});

Deno.test("validateTarEntryName accepts nested relative entries", () => {
  const valid = validateTarEntryName("self-contained/crt1-command.o");
  if (valid !== "self-contained/crt1-command.o") {
    throw new Error(`unexpected normalized path: ${valid}`);
  }
});

Deno.test("validateTarEntryName skips archive root directory entries", () => {
  if (validateTarEntryName(".") !== null) {
    throw new Error("expected . to be skipped");
  }
  if (validateTarEntryName("./") !== null) {
    throw new Error("expected ./ to be skipped");
  }
});
