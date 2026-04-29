use const_struct::*;
use parking_lot::Mutex;
use std::sync::OnceLock;
use wasi_virt_layer::{file::*, prelude::*, process::StandardProcess};

wit_bindgen::generate!({
    // the name of the world in the `*.wit` input file
    world: "init",
});

struct Wit;

impl Guest for Wit {
    fn init() {
        fn print_loop() {
            for i in 0..1000 {
                println!("Hello from a thread spawned in the `init` function! {i}");
            }
        }

        let handle = std::thread::spawn(|| {
            print_loop();
        });

        print_loop();

        handle.join().unwrap();

        println!("`init` function done.");
    }

    fn main() {
        tre::_reset();
        tre::_start();
        set_tre_args(&["--help"]);
        tre::_main();

        lsr::_reset();
        lsr::_start();
        set_lsr_args(&["--help"]);
        lsr::_main();
    }
}

export!(Wit);

static VFS: OnceLock<StandardDynamicFileSystem<StandardDynamicLFS<DefaultStdIO>>> = OnceLock::new();

fn get_vfs() -> &'static StandardDynamicFileSystem<StandardDynamicLFS<DefaultStdIO>> {
    VFS.get_or_init(|| {
        let lfs = StandardDynamicLFS::new();
        let root = lfs.add_preopen("/");
        let etc = lfs.add_dir(root, "etc").expect("Failed to create etc dir");
        lfs.add_file(etc, "config.json", b"{\"key\": \"value\"}".to_vec())
            .expect("Failed to create config.json");
        StandardDynamicFileSystem::new(lfs)
    })
}

import_wasm!(lsr);
import_wasm!(tre);

plug_fs!(get_vfs(), lsr, tre);

#[const_struct]
const VIRTUAL_ENV: VirtualEnvEmbeddedState = VirtualEnvEmbeddedState {
    environ: &["RUST_MIN_STACK=16777216", "HOME=~/"],
};
plug_env!(@embedded, VirtualEnvTy, lsr, tre);

pub struct CustomProcess;

impl wasi_virt_layer::process::ProcessExit for CustomProcess {
    fn proc_exit<Wasm: WasmAccess>(code: i32) -> ! {
        if code == 0 {
            println!("Process exited successfully with code 0.");
        } else {
            eprintln!("Process exited with error code {}.", code);
        }

        // std::process::exit(code as i32);
        panic!("WASI_VIRT_EXIT:{}", code);
    }
}

plug_process!(CustomProcess, lsr, tre);

use std::sync::LazyLock;
use wasi_virt_layer::prelude::*;

struct VirtualArgsState {
    args: Vec<String>,
}
impl<'a> VirtualArgs<'a> for VirtualArgsState {
    type Str = String;

    fn get_args(&mut self) -> &[Self::Str] {
        &self.args
    }
}

fn set_lsr_args(args: &[impl AsRef<str>]) {
    let mut state = VIRTUAL_ARGS.lock();
    state.args = Some("lsr".into())
        .into_iter()
        .chain(args.iter().map(|s| s.as_ref().to_string()))
        .collect();
}

fn set_tre_args(args: &[impl AsRef<str>]) {
    let mut state = VIRTUAL_ARGS.lock();
    state.args = Some("tre".into())
        .into_iter()
        .chain(args.iter().map(|s| s.as_ref().to_string()))
        .collect();
}

static VIRTUAL_ARGS: LazyLock<Mutex<VirtualArgsState>> = LazyLock::new(|| {
    let mut args = Vec::<String>::new();
    args.push("command".into());
    args.push("arg1".into());
    Mutex::new(VirtualArgsState { args })
});

plug_args!(@dynamic, &mut VIRTUAL_ARGS.lock(), lsr, tre);

plug_random!(tre);
