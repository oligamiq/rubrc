use const_struct::*;
use parking_lot::Mutex;
use std::sync::OnceLock;
use wasi_virt_layer::{file::*, prelude::*, wrap_unreachable};

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

const SUCCESS_FLAG: i32 = 999;
impl wasi_virt_layer::process::ProcessExit for CustomProcess {
    fn proc_exit<Wasm: WasmAccess>(code: i32) {
        if code == 0 {
            match core::any::type_name::<Wasm>() {
                v if v == core::any::type_name::<lsr>() => {
                    WrapUnreachableLsr::set_flag(SUCCESS_FLAG);
                }
                v if v == core::any::type_name::<tre>() => {
                    WrapUnreachableTre::set_flag(SUCCESS_FLAG);
                }
                _ => unreachable!(),
            }
        } else {
            eprintln!("Process exited with error code {code}.");
        }
    }
}

plug_process!(CustomProcess, lsr, tre);

use std::sync::LazyLock;

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

struct UnreachableHandler;

impl wasi_virt_layer::wasi::wrap_unreachable::WrapUnreachable for UnreachableHandler {
    fn fix_main_raw_exit_code<Wasm: WasmAccess>(code: i32) -> i32 {
        if code == 0 || code == SUCCESS_FLAG {
            0
        } else {
            eprintln!("Unexpected exit code from main: {code}. Treating as error.");
            println!("wasm access: {}", core::any::type_name::<Wasm>());
            code
        }
    }
}

wrap_unreachable!(UnreachableHandler, tre, lsr);
