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

if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
  throw new Error(`VFS bindings source directory does not exist: ${sourceDir}`);
}

const preserved = new Map();
for (const fileName of preservedFiles) {
  const filePath = join(targetDir, fileName);
  if (existsSync(filePath)) {
    preserved.set(fileName, readFileSync(filePath));
  }
}

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

for (const [fileName, contents] of preserved) {
  writeFileSync(join(targetDir, fileName), contents);
}
