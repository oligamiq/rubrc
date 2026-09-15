const p = Promise.reject("err");
const p2 = new Promise((resolve, reject) => {
    const chain = p.then(resolve, reject).finally(() => console.log("finally"));
    chain.catch(e => console.log("chain caught", e));
});
p2.catch(e => console.log("p2 caught", e));
