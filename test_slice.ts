const buf1 = new Uint8Array([1, 2, 3]);
const buf2 = buf1.slice(1);
buf2[0] = 99;
console.log(buf1[1]); // If 99, it's a view. If 2, it's a copy.
