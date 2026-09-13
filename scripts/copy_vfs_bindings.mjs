import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = process.env.VFS_BINDINGS_SOURCE_DIR ??
  fileURLToPath(new URL("../dist", import.meta.url));
const targetDir = process.env.VFS_BINDINGS_TARGET_DIR ??
  fileURLToPath(
    new URL("../page/src/worker_process/vfs_bindings", import.meta.url),
  );
const preservedFiles = [
  "inst.ts",
  "http_import.ts",
  "child_process_import.ts",
  "child_process_worker.ts",
  "package.json",
  "bun.lock",
];

function replaceGeneratedCommonType(source, pattern, replacement, label) {
  const matches = Array.from(source.matchAll(pattern));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one generated common.ts ${label}, found ${matches.length}`,
    );
  }
  return source.replace(pattern, replacement);
}

function patchGeneratedCommonTs(source) {
  source = replaceGeneratedCommonType(
    source,
    /^(\s*)worker;$/gm,
    "$1worker: any;",
    "worker field",
  );
  source = replaceGeneratedCommonType(
    source,
    /^(\s*)onmessage;$/gm,
    "$1onmessage?: (event: { data: unknown }) => void;",
    "onmessage field",
  );
  source = replaceGeneratedCommonType(
    source,
    /constructor\(url\)/g,
    "constructor(url: string | URL)",
    "constructor",
  );
  source = replaceGeneratedCommonType(
    source,
    /this\.worker\.on\("message", \(message\) =>/g,
    'this.worker.on("message", (message: unknown) =>',
    "message callback",
  );
  source = replaceGeneratedCommonType(
    source,
    /^(\s*)postMessage\(message\) \{$/gm,
    "$1postMessage(message: unknown) {",
    "postMessage method",
  );
  return source;
}

if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
  throw new Error(`VFS bindings source directory does not exist: ${sourceDir}`);
}

const sourceCommonPath = join(sourceDir, "common.ts");
const patchedGeneratedCommon =
  existsSync(sourceCommonPath) && statSync(sourceCommonPath).isFile()
    ? patchGeneratedCommonTs(readFileSync(sourceCommonPath, "utf8"))
    : undefined;

const preserved = new Map();
for (const fileName of preservedFiles) {
  const filePath = join(targetDir, fileName);
  if (existsSync(filePath)) {
    preserved.set(fileName, readFileSync(filePath));
  }
}

try {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  for (const generatedPath of ["deno.lock", "node_modules"]) {
    rmSync(join(targetDir, generatedPath), { recursive: true, force: true });
  }

  const vfsPath = join(targetDir, "vfs.js");
  if (existsSync(vfsPath) && statSync(vfsPath).isFile()) {
    const vfs = readFileSync(vfsPath, "utf8");
    writeFileSync(vfsPath, vfs.replace(/[ \t]+(?=\r?$)/gm, ""));
  }
  if (patchedGeneratedCommon !== undefined) {
    writeFileSync(join(targetDir, "common.ts"), patchedGeneratedCommon);
  }
} finally {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  for (const [fileName, contents] of preserved) {
    writeFileSync(join(targetDir, fileName), contents);
  }
}
