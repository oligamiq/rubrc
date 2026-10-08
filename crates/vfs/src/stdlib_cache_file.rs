//! The cache is Rust-side runtime state, excluded from workspace mirroring by
//! the existing `.cache` exclusion. No base64 or duplicate Web filesystem copy.
use crate::LFS;

pub(crate) fn install(lfs: &LFS, root: usize, bytes: &[u8]) -> Result<(), &'static str> {
    let mut directory = root;
    for name in [".cache", "rust-analyzer"] {
        let child = lfs
            .read_dir(directory)
            .map_err(|_| "read cache directory")?
            .into_iter()
            .find_map(|(entry, id)| (entry == name).then_some(id));
        directory = match child {
            Some(id) => id,
            None => lfs
                .add_dir(directory, name)
                .map_err(|_| "create cache directory")?,
        };
    }
    let existing = lfs
        .read_dir(directory)
        .map_err(|_| "read cache directory")?
        .into_iter()
        .find_map(|(name, id)| (name == "std.salsa").then_some(id));
    if let Some(id) = existing {
        lfs.write_file(id, bytes.to_vec())
            .map_err(|_| "replace cache file")?;
    } else {
        lfs.add_file(directory, "std.salsa", bytes.to_vec())
            .map_err(|_| "create cache file")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installs_and_replaces_exact_binary_bytes() {
        let fs = LFS::new();
        let root = fs.add_preopen(".");
        install(&fs, root, &[0, 128, 255]).unwrap();
        install(&fs, root, &[7, 0]).unwrap();
        let mut id = root;
        for component in [".cache", "rust-analyzer", "std.salsa"] {
            id = fs
                .read_dir(id)
                .unwrap()
                .into_iter()
                .find(|(name, _)| name == component)
                .unwrap()
                .1;
        }
        assert_eq!(fs.read_file(id).unwrap(), &[7, 0]);
    }
}
