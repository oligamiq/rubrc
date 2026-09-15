const p = new Promise((r, reject) => setTimeout(() => reject(new Error("late")), 100));
const timeout = new Promise(r => setTimeout(r, 10));
Promise.race([p, timeout]).then(() => console.log("race resolved"));
setTimeout(() => console.log("done"), 200);
