import { writeFileSync } from "fs";
writeFileSync("test_sab5_worker.ts", `
self.onmessage = e => {
  postMessage(e.data + " world");
}
`);
const w = new Worker(new URL("test_sab5_worker.ts", import.meta.url).href);
w.postMessage("hello");
w.onmessage = e => { console.log(e.data); process.exit(0); }
