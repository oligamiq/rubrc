const sab = new SharedArrayBuffer(8);
console.log(sab instanceof SharedArrayBuffer);
const cloned = structuredClone(sab);
console.log(cloned instanceof SharedArrayBuffer);
console.log(cloned instanceof ArrayBuffer);
