fn main() {
    let id = std::thread::current().id();
    println!("{:?}", id);
}
