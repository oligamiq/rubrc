process.on('unhandledRejection', (err) => {
  console.error("CAUGHT UNHANDLED:", err.message);
});

async function run() {
  const p = new Promise((resolve, reject) => {
    setTimeout(() => { reject(new Error("late rejection")); }, 100);
  });
  
  const timeout = new Promise((resolve) => setTimeout(resolve, 10));
  
  await Promise.race([p, timeout]);
  console.log("race finished");
}

run();
