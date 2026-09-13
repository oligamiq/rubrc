const shell = await Deno.readTextFile("crates/vfs-shell/src/main.rs");
const vfs = await Deno.readTextFile("crates/vfs/src/lib.rs");
const wit = await Deno.readTextFile("crates/vfs/wit/vfs-host.wit");

if (!shell.includes("BootstrapRustSrc = 6")) {
  throw new Error("dedicated shell bootstrap event is missing");
}
if (!shell.includes("vfs_shell_startup_sysroot_load_state")) {
  throw new Error("shell startup sysroot state export is missing");
}
if (!vfs.includes("EVENT_TYPE_BOOTSTRAP_RUST_SRC: u32 = 8")) {
  throw new Error("outer bootstrap event is missing");
}
if (!wit.includes("export startup-sysroot-load-state: func(kind: u32) -> u32;")) {
  throw new Error("WIT startup sysroot state export is missing");
}
