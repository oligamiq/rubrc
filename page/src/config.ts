import { File } from "@bjorn3/browser_wasi_shim";

export const default_value = `// /main.rs
fn main() {
    let first_time = std::time::SystemTime::now();

    let count = std::env::args()
        .nth(1)
        .map(|arg| arg.parse::<usize>().ok())
        .flatten()
        .unwrap_or(10);

    (0..=count).for_each(|i| println!("{i}"));

    println!("Time: {:?}", first_time.elapsed().unwrap());
}
`;

export const rust_file: File = new File(
  new TextEncoder().encode(default_value),
);
