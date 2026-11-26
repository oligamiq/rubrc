use std::{env, fs, path::PathBuf};
fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../../.worktrees/wvl-lock-batching/wasi_virt_layer-cli/src/wasm_stream")
        .canonicalize().expect("pinned WVL checkout required");
    let mut modules = String::from("pub mod wasm_stream {\n");
    for name in ["pipeline", "translator", "mem_info", "own_memory_abi"] {
        let path = root.join(format!("{name}.rs"));
        println!("cargo:rerun-if-changed={}", path.display());
        modules.push_str(&format!("#[path = {:?}] pub mod {name};\n", path));
    }
    modules.push_str("pub mod passes {\n");
    for name in ["memory_lock_batching", "multi_memory_lowering"] {
        let path = root.join("passes").join(format!("{name}.rs"));
        println!("cargo:rerun-if-changed={}", path.display());
        modules.push_str(&format!("#[path = {:?}] pub mod {name};\n", path));
    }
    modules.push_str("}}\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("actual_sources.rs"), modules).unwrap();
}
