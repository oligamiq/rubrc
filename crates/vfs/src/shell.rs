#[link(wasm_import_module = "wasip1_vfs_vfs-shell")]
unsafe extern "C" {
    pub fn vfs_shell_write_stdout(id: u32, data: *const u8, len: usize) -> usize;
    pub fn vfs_shell_write_stderr(id: u32, data: *const u8, len: usize) -> usize;
}

thread_local! {
    pub static CURRENT_CONTEXT_ID: std::cell::Cell<Option<u32>> = std::cell::Cell::new(None);
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_execute_command(args_ptr: *const u8, args_len: usize, context_id: u32) -> i32 {
    let args_str = unsafe { std::slice::from_raw_parts(args_ptr, args_len) };
    let args_string = String::from_utf8_lossy(args_str);
    let args_vec: Vec<String> = args_string.split('\0').map(String::from).collect();

    CURRENT_CONTEXT_ID.with(|id| id.set(Some(context_id)));
    let _req = crate::command::handle_command(args_vec);
    // You can match req to return a status code (e.g. 0 for success).
    CURRENT_CONTEXT_ID.with(|id| id.set(None));
    0
}
