import { MessageChannel, receiveMessageOnPort } from 'worker_threads';
const { port1, port2 } = new MessageChannel();
const sab = new SharedArrayBuffer(8);
port1.postMessage(sab);
const cloned = receiveMessageOnPort(port2).message;
console.log(cloned instanceof SharedArrayBuffer);
