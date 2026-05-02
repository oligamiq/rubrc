fn main() {
    let handle = std::thread::spawn(|| {
        println!("Hello from rustc mock thread!");
    });
    handle.join().unwrap();
}