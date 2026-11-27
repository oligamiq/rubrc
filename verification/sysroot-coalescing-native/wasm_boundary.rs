// Actual production reader exercised through a real Wasm→JS import.
#![allow(dead_code)]
#[path = "../../crates/vfs-shell/src/sysroot_extraction.rs"]
mod sysroot_extraction;
use std::io::Read;
#[link(wasm_import_module = "probe")]
unsafe extern "C" {
    fn chunk(pointer: *mut u8, length: usize) -> i32;
    fn reset(length: usize);
    fn calls() -> usize;
    fn copied() -> usize;
}
fn main() {
    for len in [0, 1, 65535, 65536, 65537, 1048593] {
        unsafe { reset(len) };
        let mut reader = sysroot_extraction::SysrootArchiveReader::new(len, || false, |buffer: &mut [u8]| {
            if unsafe { chunk(buffer.as_mut_ptr(), buffer.len()) } != 0 { return Err(std::io::Error::other("host failure")); }
            Ok(())
        });
        let mut position = 0;
        let mut buffer = vec![0; 777];
        loop {
            let n = reader.read(&mut buffer).unwrap();
            if n == 0 { break; }
            for (i, byte) in buffer[..n].iter().enumerate() { assert_eq!(*byte, ((position + i) % 251) as u8); }
            position += n;
        }
        assert_eq!(position, len);
        assert_eq!(unsafe { copied() }, len);
        #[cfg(feature = "sysroot-read-coalescing")]
        let expected = len.div_ceil(65536);
        #[cfg(not(feature = "sysroot-read-coalescing"))]
        let expected = len.div_ceil(777);
        assert_eq!(unsafe { calls() }, expected);
        println!("length={len} calls={expected} exact-bytes=true");
    }
    println!("WASM_BOUNDARY_PASS");
}
