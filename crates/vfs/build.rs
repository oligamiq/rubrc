fn initial_heap_link_arg(
    target: &str,
    configured: Option<&str>,
) -> Result<Option<&'static str>, &'static str> {
    let Some(value) = configured.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    // Native checks must not receive a WASM linker argument. In particular,
    // inspect Cargo's target, not the build script's own host cfg.
    if !target.starts_with("wasm") {
        return Ok(None);
    }
    if target != "wasm32-wasip1-threads" {
        return Err("VFS initial-heap experiment requires wasm32-wasip1-threads");
    }
    if value != "536870912" {
        return Err("RUBRC_VFS_INITIAL_HEAP_BYTES only supports 536870912 in this experiment");
    }
    Ok(Some("--initial-heap=536870912"))
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RUBRC_VFS_INITIAL_HEAP_BYTES");
    let target = std::env::var("TARGET").expect("Cargo must provide TARGET");
    let configured = std::env::var("RUBRC_VFS_INITIAL_HEAP_BYTES").ok();
    match initial_heap_link_arg(&target, configured.as_deref()) {
        Ok(Some(argument)) => {
            // Scope the option to this package's cdylib, never to vfs-shell
            // or the separately built analyzer/compiler guests.
            println!("cargo:rustc-link-arg-cdylib={argument}");
            println!("cargo:warning=VFS initial-heap experiment: 512 MiB");
        }
        Ok(None) => {}
        Err(message) => panic!("{message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::initial_heap_link_arg;

    #[test]
    fn default_does_not_change_the_linker() {
        assert_eq!(
            initial_heap_link_arg("wasm32-wasip1-threads", None),
            Ok(None)
        );
        assert_eq!(
            initial_heap_link_arg("wasm32-wasip1-threads", Some("")),
            Ok(None)
        );
    }

    #[test]
    fn only_the_validated_wasi_target_gets_the_initial_heap_argument() {
        assert_eq!(
            initial_heap_link_arg("wasm32-wasip1-threads", Some("536870912")),
            Ok(Some("--initial-heap=536870912")),
        );
        assert_eq!(
            initial_heap_link_arg("x86_64-unknown-linux-gnu", Some("536870912")),
            Ok(None)
        );
    }

    #[test]
    fn unsupported_wasm_target_is_not_silently_mislabeled() {
        assert!(initial_heap_link_arg("wasm32-unknown-unknown", Some("536870912")).is_err());
    }

    #[test]
    fn arbitrary_heap_sizes_are_not_part_of_this_experiment() {
        for value in ["0", "67108864", "invalid", "536870912 --other-flag"] {
            assert!(initial_heap_link_arg("wasm32-wasip1-threads", Some(value)).is_err());
        }
    }
}
