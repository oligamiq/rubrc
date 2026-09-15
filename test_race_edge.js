process.on('unhandledRejection', (err) => {
  console.error("CAUGHT UNHANDLED:", err.message);
});

async function run() {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => { reject(new Error("TimeoutError")); }, 10);
  });
  
  const evaluation = new Promise((resolve) => setTimeout(resolve, 5));
  
  await Promise.race([evaluation, timeout]);
  
  // We do NOT clear the timer here, simulating the exact same time edge case!
  console.log("race finished");
}

run();
