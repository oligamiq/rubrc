import {
  createRustSrcFsEndpoint,
  RUST_SRC_MOUNT_PATH,
  RustSrcVfsError,
  rustSrcRelativePath,
  type RustSrcRpcRoot,
} from "./rust_src_vfs_rpc.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_LEN = 48;
const OP_STAT = 1;
const OP_READ = 2;
const OP_READDIR = 3;
const OK = 0;
const NOT_MOUNTED = 2;
const BUFFER_TOO_SMALL = 4;
const FILE = 1;
const DIRECTORY = 2;

type Entry = { type: "file"; data: Uint8Array; mtime: number } | {
  type: "directory";
  entries: string[];
  mtime: number;
};
class FakeRoot implements RustSrcRpcRoot {
  readonly memory = new WebAssembly.Memory({ initial: 2 });
  mounted = true;
  frees = 0;
  private next = 1024;
  readonly entries = new Map<string, Entry>([
    ["", { type: "directory", entries: ["core", "Cargo.toml"], mtime: 1000 }],
    ["core", { type: "directory", entries: ["src"], mtime: 2000 }],
    ["core/src", { type: "directory", entries: ["lib.rs"], mtime: 3000 }],
    ["core/src/lib.rs", {
      type: "file",
      data: encoder.encode("pub const CORE: &str = \"ok\";\n"),
      mtime: 4000,
    }],
    ["Cargo.toml", {
      type: "file",
      data: encoder.encode("[workspace]\n"),
      mtime: 5000,
    }],
  ]);

  allocBuf(len: number): number {
    const ptr = this.next;
    this.next += len + 64;
    return ptr;
  }

  freeBuf(_ptr: number, _len: number): void {
    this.frees++;
  }
  dispatch(_sessionId: number, eventType: number, ptr: number, len: number): void {
    assert(eventType === 10, `wrong event type ${eventType}`);
    const header = new DataView(this.memory.buffer, ptr, HEADER_LEN);
    const request = new Uint8Array(this.memory.buffer, ptr, len);
    const operation = header.getUint32(0, true);
    const pathLen = header.getUint32(4, true);
    const offset = Number(header.getBigUint64(8, true));
    const capacity = header.getUint32(16, true);
    const path = decoder.decode(request.slice(HEADER_LEN, HEADER_LEN + pathLen));
    const outputStart = HEADER_LEN + pathLen;

    header.setUint32(20, this.mounted ? OK : NOT_MOUNTED, true);
    header.setUint32(24, 0, true);
    header.setUint32(28, 0, true);
    header.setBigUint64(32, 0n, true);
    header.setBigUint64(40, 0n, true);
    if (!this.mounted) return;

    const entry = this.entries.get(path);
    if (!entry) {
      header.setUint32(20, 3, true);
      return;
    }
    if (operation === OP_STAT) {
      header.setUint32(24, entry.type === "file" ? FILE : DIRECTORY, true);
      header.setBigUint64(32, BigInt(entry.type === "file" ? entry.data.length : 0), true);
      header.setBigUint64(40, BigInt(entry.mtime), true);
      return;
    }
    if (operation === OP_READ) {
      if (entry.type !== "file") {
        header.setUint32(20, 3, true);
        return;
      }
      const chunk = entry.data.slice(offset, offset + capacity);
      request.set(chunk, outputStart);
      header.setUint32(28, chunk.length, true);
      return;
    }
    if (operation === OP_READDIR) {
      if (entry.type !== "directory") {
        header.setUint32(20, 3, true);
        return;
      }
      const encoded = encoder.encode(JSON.stringify(entry.entries));
      header.setUint32(28, encoded.length, true);
      if (encoded.length > capacity) {
        header.setUint32(20, BUFFER_TOO_SMALL, true);
        return;
      }
      request.set(encoded, outputStart);
      return;
    }
    header.setUint32(20, 1, true);
  }
}

Deno.test("rust-src RPC adapter reads stat file bytes and directory entries", () => {
  const root = new FakeRoot();
  const endpoint = createRustSrcFsEndpoint(root, root.memory);
  const stat = endpoint({ operation: "stat", path: "core/src/lib.rs" });
  if (stat.operation !== "stat") throw new Error("wrong stat response");
  assert(stat.stat.type === "file", "wrong stat type");
  assert(stat.stat.size > 0, "missing file size");
  assert(stat.stat.mtime === 4000, "wrong mtime");

  const file = endpoint({ operation: "readFile", path: "core/src/lib.rs" });
  if (file.operation !== "readFile") throw new Error("wrong read response");
  assert(decoder.decode(file.data).includes("CORE"), "wrong file bytes");

  const dir = endpoint({ operation: "readdir", path: "" });
  if (dir.operation !== "readdir") throw new Error("wrong readdir response");
  assert(dir.entries.join() === "core,Cargo.toml", "wrong directory entries");
  assert(root.frees === 5, `unexpected free count ${root.frees}`);
});

Deno.test("rust-src RPC adapter reports mount absence", () => {
  const root = new FakeRoot();
  root.mounted = false;
  const endpoint = createRustSrcFsEndpoint(root, root.memory);
  let rejected = false;
  try {
    endpoint({ operation: "stat", path: "core/src/lib.rs" });
  } catch (error) {
    rejected = error instanceof RustSrcVfsError && error.code === "NotMounted";
  }
  assert(rejected, "missing mount was not rejected");
});
Deno.test("rust-src mount path conversion only accepts the mounted subtree", () => {
  assert(rustSrcRelativePath(RUST_SRC_MOUNT_PATH) === "", "mount root mismatch");
  assert(
    rustSrcRelativePath(`${RUST_SRC_MOUNT_PATH}/core/src/lib.rs`) ===
      "core/src/lib.rs",
    "child path mismatch",
  );
  assert(
    rustSrcRelativePath("/sysroot/lib/rustlib/src/rust/library-old") === undefined,
    "prefix sibling was accepted",
  );
});
