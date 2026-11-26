use std::{env, path::PathBuf, process::Command};

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let source = root.join("../../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs");
    let transform = root.join("source_transform.py");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed={}", transform.display());
    let status = Command::new("python3")
        .arg(transform)
        .arg(source)
        .arg(env::var_os("OUT_DIR").unwrap())
        .status()
        .expect("python3 must run checked source transform");
    assert!(status.success(), "checked source transform failed");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    std::fs::write(
        out.join("actual_module.rs"),
        format!("#[path = {:?}]\nmod actual;\n", out.join("memory_lock_instrumented.rs")),
    ).unwrap();
}
