use wasi_virt_layer::memory::WasmAccess as _;

use crate::vfs_shell;

// ----------------------------------------------------------
// Imports from vfs-shell: all scalar-only, no raw pointers
// ----------------------------------------------------------

#[link(wasm_import_module = "wasip1_vfs_vfs-shell")]
unsafe extern "C" {
    /// Get pointer (in vfs-shell's memory) to the command args buffer
    pub fn vfs_shell_get_cmd_args_ptr() -> u32;
    /// Get length of the command args buffer
    pub fn vfs_shell_get_cmd_args_len() -> u32;

    /// Allocate a buffer in vfs-shell's memory (returns address as u32)
    pub fn vfs_shell_alloc_buf(len: u32) -> u32;
    /// Free a buffer in vfs-shell's memory
    pub fn vfs_shell_free_buf(ptr: u32, len: u32);

    /// Write stdout: ptr/len refer to vfs-shell's own memory
    pub fn vfs_shell_write_stdout(id: u32, ptr: u32, len: u32) -> u32;
    /// Write stderr: ptr/len refer to vfs-shell's own memory
    pub fn vfs_shell_write_stderr(id: u32, ptr: u32, len: u32) -> u32;

    /// Send a character to vfs-shell
    pub fn vfs_shell_input_char(c: u32);

    /// Interrupt the shell
    pub fn vfs_shell_interrupt();

    pub fn vfs_shell_resize(columns: u32, lines: u32);
}

thread_local! {
    pub static CURRENT_CONTEXT_ID: std::cell::Cell<Option<u32>> = std::cell::Cell::new(None);
}

/// Called by vfs-shell via C-ABI. Only receives a scalar context_id.
/// Reads args from vfs-shell's memory using vfs_shell::memcpy_to.
#[unsafe(no_mangle)]
pub extern "C" fn vfs_execute_command(context_id: u32) -> i32 {
    // 1. Get args pointer+length from vfs-shell (scalars)
    let args_ptr = unsafe { vfs_shell_get_cmd_args_ptr() } as *const u8;
    let args_len = unsafe { vfs_shell_get_cmd_args_len() } as usize;

    println!("vfs_execute_command: getting array of len {} at ptr {:?}", args_len, args_ptr);

    // 2. Copy args from vfs-shell's memory into our local buffer
    let args_data = vfs_shell::get_array(args_ptr, args_len);
    let args_string = String::from_utf8_lossy(&args_data);
    let args_vec: Vec<String> = args_string.split('\0').map(String::from).collect();

    println!("vfs_execute_command: executing {:?}", args_vec);

    // 3. Execute command with context_id for stdout/stderr routing
    CURRENT_CONTEXT_ID.with(|id| id.set(Some(context_id)));
    crate::command::handle_command(args_vec);
    CURRENT_CONTEXT_ID.with(|id| id.set(None));
    0
}
