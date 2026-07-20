const shell = await Deno.readTextFile("crates/vfs-shell/src/main.rs");
const vfs = await Deno.readTextFile("crates/vfs/src/lib.rs");
const wit = await Deno.readTextFile("crates/vfs/wit/vfs-host.wit");

if (!shell.includes("BootstrapRustSrc = 6")) {
  throw new Error("dedicated shell bootstrap event is missing");
}
if (!shell.includes("vfs_shell_rust_src_load_state")) {
  throw new Error("shell bootstrap state export is missing");
}
if (!vfs.includes("EVENT_TYPE_BOOTSTRAP_RUST_SRC: u32 = 8")) {
  throw new Error("outer bootstrap event is missing");
}
if (!wit.includes("export rust-src-load-state: func() -> u32;")) {
  throw new Error("WIT bootstrap state export is missing");
}
