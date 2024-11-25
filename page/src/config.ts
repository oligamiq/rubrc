import { File } from '@bjorn3/browser_wasi_shim';

export const default_value = `// /main.rs
fn main() {
  println!("Hello, world!");
}
`;

export const rust_file: File = new File(
  new TextEncoder().encode(default_value),
);
