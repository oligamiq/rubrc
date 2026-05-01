use wasi_virt_layer::file::*;
fn main() {
    let lfs = StandardDynamicLFS::<DefaultStdIO>::new();
    let root = lfs.add_preopen("/");
    let cloned = lfs.clone();
}
