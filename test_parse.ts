const view = new Uint8Array([97, 98, 99]);
const i = view.indexOf(0);
const td = new TextDecoder();
console.log(td.decode(view.slice(0, i)));
