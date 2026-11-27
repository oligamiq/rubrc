// Compile the actual production module, including its unit tests, not a copy.
#![allow(dead_code)]
#[path = "../../crates/vfs-shell/src/sysroot_extraction.rs"]
mod sysroot_extraction;

#[cfg(test)]
mod tests;
