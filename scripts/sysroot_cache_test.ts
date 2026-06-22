import {
  prepareCachedSysroot,
  type SysrootCacheDeps,
  sysrootCachePaths,
  validateTarEntryName,
} from "./sysroot_cache.ts";

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
  const expected = [
    "remove:workspace/sysroot",
    "mkdir:.cache/sysroot",
    "exists:.cache/sysroot/wasm32-wasip1.tar.br",
    "fetch:https://example.invalid/sysroot.tar.br",
    "write:.cache/sysroot/wasm32-wasip1.tar.br.tmp:9,8,7",
    "rename:.cache/sysroot/wasm32-wasip1.tar.br.tmp:.cache/sysroot/wasm32-wasip1.tar.br",
    "mkdir:workspace/sysroot/lib/rustlib/wasm32-wasip1/lib",
    "extract:workspace/sysroot/lib/rustlib/wasm32-wasip1/lib:9,8,7",
  ];
  if (calls.join("\n") !== expected.join("\n")) {
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
