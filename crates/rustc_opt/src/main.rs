fn main() {
  std::thread::spawn(|| {
    println!("Hello from a thread!");
  });
}
