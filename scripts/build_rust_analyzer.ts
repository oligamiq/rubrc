import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = new URL("../", import.meta.url);
const analyzer = new URL("../../rust-analyzer/", import.meta.url);
const toolchain = Deno.env.get("RA_TOOLCHAIN") ?? "nightly";
const targetDir = resolve(fileURLToPath(analyzer), Deno.env.get("CARGO_TARGET_DIR") ?? "target");
const input = resolve(targetDir, "wasm32-wasip1-threads/release/rust-analyzer.wasm");
const output = fileURLToPath(new URL("crates/vfs/lsp_opt.wasm", root));
// Salsa cancellation uses unwinding. Rustup's prebuilt WASI std uses abort,
// so std and panic_unwind must be rebuilt with the analyzer.
const unwindFlags = [
  "-Cpanic=unwind",
  "-Ctarget-feature=+exception-handling",
  "-Cllvm-args=-wasm-use-legacy-eh=false",
];
const encodedFlags = Deno.env.get("CARGO_ENCODED_RUSTFLAGS");
const env: Record<string, string> = encodedFlags === undefined
  ? { RUSTFLAGS: `${Deno.env.get("RUSTFLAGS") ?? ""} ${unwindFlags.join(" ")}` }
  : {
    CARGO_ENCODED_RUSTFLAGS: [
      ...(encodedFlags ? [encodedFlags] : []),
      ...unwindFlags,
    ].join("\x1f"),
  };
const status = await new Deno.Command("cargo", {
  cwd: fileURLToPath(analyzer),
  env,
  args: [
    `+${toolchain}`,
    "build",
    "-Zbuild-std=std,panic_unwind",
    "-p",
    "rust-analyzer",
    "--release",
    "--target",
    "wasm32-wasip1-threads",
    ...(Deno.env.get("RA_CACHE_ITEM_TREES") === "1" ? ["--features", "cache-item-trees"] : []),
    ...(Deno.env.get("RA_CACHE_CODEC_BENCH") === "1"
      ? ["--features", "cache-codec-bench"]
      : []),
  ],
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;
if (!status.success) throw new Error("rust-analyzer WASM build failed");
async function validate(path: string): Promise<void> {
  const result = await new Deno.Command("wasm-tools", {
    args: ["validate", "--features", "all", path], stdout: "inherit", stderr: "inherit",
  }).spawn().status;
  if (!result.success) throw new Error(`invalid analyzer WASM: ${path}`);
}
await validate(input);
const optimized = await new Deno.Command("wasm-opt", {
  args: [
    "-O3",
    // Use the features declared by rustc. --all-features lets Binaryen emit
    // GC/reference instructions that the VFS translator does not support.
    input,
    "-o",
    `${output}.tmp`,
  ],
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;
if (!optimized.success) {
  throw new Error("rust-analyzer WASM optimization failed");
}
await validate(`${output}.tmp`);
await Deno.rename(`${output}.tmp`, output);
