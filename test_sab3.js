import v8 from 'v8';
const sab = new SharedArrayBuffer(8);
const cloned = v8.deserialize(v8.serialize(sab));
console.log(cloned instanceof SharedArrayBuffer);
