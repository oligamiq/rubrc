const { port1, port2 } = new MessageChannel();
const sab = new SharedArrayBuffer(8);
port1.postMessage(sab);
port2.onmessage = e => {
  console.log(e.data instanceof SharedArrayBuffer);
  process.exit(0);
};
