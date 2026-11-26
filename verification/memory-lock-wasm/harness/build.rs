use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=WVL_SOURCE_ROOT");
    let root = PathBuf::from(env::var("WVL_SOURCE_ROOT").expect("set WVL_SOURCE_ROOT"))
        .join("wasi_virt_layer-cli/src").canonicalize().expect("WVL source checkout");
    let abi = root.join("abi.rs");
    println!("cargo:rerun-if-changed={}", abi.display());
    let mut modules = format!("#[path = {abi:?}] pub mod abi;\npub mod wasm_stream {{\n");
    for name in ["pipeline", "translator", "mem_info", "own_memory_abi"] {
        let path = root.join("wasm_stream").join(format!("{name}.rs"));
        println!("cargo:rerun-if-changed={}", path.display());
        modules.push_str(&format!("#[path = {path:?}] pub mod {name};\n"));
    }
    modules.push_str("pub mod passes {\n");
    for name in ["post_combine", "fn_in_starts", "reactor_initialize"] {
        let path = root.join("wasm_stream/passes").join(format!("{name}.rs"));
        println!("cargo:rerun-if-changed={}", path.display());
        modules.push_str(&format!("#[path = {path:?}] pub mod {name};\n"));
    }
    modules.push_str("}}\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("actual_sources.rs"), modules).unwrap();
}
