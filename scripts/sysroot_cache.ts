import { parseTar } from "../lib/src/parse_tar.ts";

export type SysrootCacheSource = "cache" | "download";

export interface SysrootCachePaths {
  cacheDir: string;
  cacheArchive: string;
  expandedSysroot: string;
  sysrootLibDir: string;
  url: string;
}

export interface SysrootCacheResult extends SysrootCachePaths {
  source: SysrootCacheSource;
}

export interface SysrootCacheDeps {
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  fetchBytes(url: string): Promise<Uint8Array>;
  extractTarBr(data: Uint8Array, destination: string): Promise<void>;
}

export interface SysrootCacheOptions {
  triple: string;
  cacheDir: string;
  workspaceSysroot: string;
  url: string;
  deps: SysrootCacheDeps;
}

const DEFAULT_TRIPLE = "wasm32-wasip1";
const DEFAULT_CACHE_DIR = ".rubrc-cache/sysroot";
const DEFAULT_WORKSPACE_SYSROOT = "test_workspace_rustc/sysroot";
const DEFAULT_BASE_URL = "https://oligamiq.github.io/rust_wasm/v0.2.0";

export function sysrootCachePaths(
  options: Partial<Omit<SysrootCacheOptions, "deps">> = {},
): SysrootCachePaths {
  const triple = options.triple ?? DEFAULT_TRIPLE;
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  return {
    cacheDir,
    cacheArchive: `${cacheDir}/${triple}.tar.br`,
    expandedSysroot: options.workspaceSysroot ?? DEFAULT_WORKSPACE_SYSROOT,
    sysrootLibDir: `${
      options.workspaceSysroot ?? DEFAULT_WORKSPACE_SYSROOT
    }/lib/rustlib/${triple}/lib`,
    url: options.url ?? `${DEFAULT_BASE_URL}/${triple}.tar.br`,
  };
}

export async function prepareCachedSysroot(
  options: Partial<SysrootCacheOptions> = {},
): Promise<SysrootCacheResult> {
  const paths = sysrootCachePaths(options);
  const deps = options.deps ?? denoSysrootCacheDeps;

  await deps.remove(paths.expandedSysroot);
  await deps.mkdir(paths.cacheDir);

  let source: SysrootCacheSource;
  let archive: Uint8Array;
  if (await deps.exists(paths.cacheArchive)) {
    source = "cache";
    archive = await deps.readFile(paths.cacheArchive);
  } else {
    source = "download";
    archive = await deps.fetchBytes(paths.url);
    await deps.writeFile(`${paths.cacheArchive}.tmp`, archive);
    await deps.rename(`${paths.cacheArchive}.tmp`, paths.cacheArchive);
  }

  await deps.mkdir(paths.sysrootLibDir);
  await deps.extractTarBr(archive, paths.sysrootLibDir);

  return { ...paths, source };
}

const denoSysrootCacheDeps: SysrootCacheDeps = {
  async exists(path) {
    try {
      await Deno.stat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  },
  async remove(path) {
    await Deno.remove(path, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    });
  },
  async mkdir(path) {
    await Deno.mkdir(path, { recursive: true });
  },
  readFile(path) {
    return Deno.readFile(path);
  },
  writeFile(path, data) {
    return Deno.writeFile(path, data);
  },
  rename(from, to) {
    return Deno.rename(from, to);
  },
  async fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `failed to download sysroot: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  },
  extractTarBr(data, destination) {
    return extractTarBr(data, destination);
  },
};

export function validateTarEntryName(name: string): string | null {
  if (name.startsWith("/") || name === ".." || name.startsWith("../")) {
    throw new Error(`unsafe sysroot archive entry: ${name}`);
  }

  const parts: string[] = [];
  for (const part of name.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        throw new Error(`unsafe sysroot archive entry: ${name}`);
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.join("/");
}

async function extractTarBr(
  data: Uint8Array,
  destination: string,
): Promise<void> {
  const archive = new ArrayBuffer(data.byteLength);
  new Uint8Array(archive).set(data);
  const stream = new Blob([archive]).stream().pipeThrough(
    new DecompressionStream("brotli"),
  );

  const files: { path: string; data?: Uint8Array; isDirectory: boolean }[] = [];
  await parseTar(stream, (file) => {
    const name = validateTarEntryName(file.name);
    if (name === null) {
      return;
    }
    const path = `${destination}/${name}`;
    const type = (file as { type?: unknown }).type;
    if (type === "directory") {
      files.push({ path, isDirectory: true });
    } else if (type === "file") {
      files.push({
        path,
        data: file.data ?? new Uint8Array(),
        isDirectory: false,
      });
    }
  });

  for (const file of files) {
    if (file.isDirectory) {
      await Deno.mkdir(file.path, { recursive: true });
    } else {
      const parent = file.path.slice(0, file.path.lastIndexOf("/"));
      if (parent) {
        await Deno.mkdir(parent, { recursive: true });
      }
      await Deno.writeFile(file.path, file.data ?? new Uint8Array());
    }
  }
}
