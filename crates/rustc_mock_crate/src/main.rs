fn main() {
    std::thread::spawn(|| {
        println!("Hello from a thread!");
    })
    .join()
    .unwrap();

    println!("Hello from the main thread!");
}
