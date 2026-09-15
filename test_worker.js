const w = new Worker(new URL("data:text/javascript,postMessage('hello');"));
w.onmessage = e => { console.log(e.data); process.exit(0); }
