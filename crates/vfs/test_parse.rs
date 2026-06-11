use wasmparser::{Parser, Payload};
fn main() {
    let bytes = hex::decode("41feffffff0771").unwrap();
    let mut reader = wasmparser::BinaryReader::new(&bytes, 0);
    while !reader.eof() {
        let op = reader.read_operator().unwrap();
        println!("{:?}", op);
    }
}
