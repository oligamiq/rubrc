#[link(wasm_import_module = "wasip1_vfs_vfs_shell")]
unsafe extern "C" {
  fn example_external_function(arg1: i32, arg2: *const u8, arg2_len: usize) -> i32;
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn example_external_function2(arg1: i32, arg2: *const u8, arg2_len: usize) -> i32 {
  println!("Called example_external_function2 with arg1: {}, arg2: {}", arg1, std::str::from_utf8(std::slice::from_raw_parts(arg2, arg2_len)).unwrap_or("<invalid utf-8>"));
  0
}
