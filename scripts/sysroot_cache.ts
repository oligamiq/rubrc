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
const REQUIRED_RUST_SRC_ENTRIES = [
  "core/src/lib.rs",
  "alloc/src/lib.rs",
  "std/src/lib.rs",
] as const;

export function rustSrcToolchainIdentity(
  rustcVerboseVersion: string,
  sysroot: string,
): string {
  return JSON.stringify({
    schema: 1,
    rustc: rustcVerboseVersion.trim(),
    sysroot,
  });
}

export function rustSrcCacheMatchesIdentity(
  expected: string,
  cached: string,
): boolean {
  return expected === cached.trim();
}

export function deterministicRustSrcTarArgs(libraryPath: string): string[] {
  return [
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
    libraryPath,
    ".",
  ];
}

type RustSrcArchiveEntryLister = (
  archive: Uint8Array,
) => Promise<readonly string[]>;

async function listRustSrcArchiveEntries(
  archive: Uint8Array,
): Promise<readonly string[]> {
  const buffer = new ArrayBuffer(archive.byteLength);
  new Uint8Array(buffer).set(archive);
  const stream = new Blob([buffer]).stream().pipeThrough(
    new DecompressionStream("brotli"),
  );
  const entries: string[] = [];
  await parseTar(stream, (file) => entries.push(file.name));
  return entries;
}

export async function validateRustSrcArchive(
  archive: Uint8Array,
  listEntries: RustSrcArchiveEntryLister = listRustSrcArchiveEntries,
): Promise<boolean> {
  try {
    const normalized = new Set<string>();
    for (const entry of await listEntries(archive)) {
      const name = validateTarEntryName(entry);
      if (name !== null) normalized.add(name);
    }
    return REQUIRED_RUST_SRC_ENTRIES.every((entry) => normalized.has(entry));
  } catch {
    return false;
  }
}

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

export async function prepareCachedArchive(
  options: Pick<
    Partial<SysrootCacheOptions>,
    "triple" | "cacheDir" | "url" | "deps"
  > = {},
): Promise<{
  archive: Uint8Array;
  source: SysrootCacheSource;
  cacheArchive: string;
  url: string;
}> {
  const triple = options.triple ?? DEFAULT_TRIPLE;
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const cacheArchive = `${cacheDir}/${triple}.tar.br`;
  const url = options.url ?? `${DEFAULT_BASE_URL}/${triple}.tar.br`;
  const deps = options.deps ?? denoSysrootCacheDeps;

  await deps.mkdir(cacheDir);
  if (await deps.exists(cacheArchive)) {
    return {
      archive: await deps.readFile(cacheArchive),
      source: "cache",
      cacheArchive,
      url,
    };
  }

  const archive = await deps.fetchBytes(url);
  await deps.writeFile(`${cacheArchive}.tmp`, archive);
  await deps.rename(`${cacheArchive}.tmp`, cacheArchive);
  return { archive, source: "download", cacheArchive, url };
}

export async function prepareCachedSysroot(
  options: Partial<SysrootCacheOptions> = {},
): Promise<SysrootCacheResult> {
  const paths = sysrootCachePaths(options);
  const deps = options.deps ?? denoSysrootCacheDeps;

  await deps.remove(paths.expandedSysroot);
  const { archive, source } = await prepareCachedArchive(options);

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
