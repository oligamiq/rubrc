const p1 = new Promise((resolve, reject) => setTimeout(() => reject(new Error("error later")), 100));
const p2 = Promise.resolve("done now");
Promise.race([p1, p2]).then(console.log);
setTimeout(() => console.log("done waiting"), 200);
