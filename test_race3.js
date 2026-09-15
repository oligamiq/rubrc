process.on('unhandledRejection', (err) => {
  console.error("CAUGHT UNHANDLED:", err.message);
});

async function run() {
  const evaluate = () => new Promise((resolve, reject) => {
    setTimeout(() => { reject(new Error("late rejection")); }, 100);
  });
  
  const evaluation = Promise.resolve().then(evaluate);
  
  const timeout = new Promise((resolve) => setTimeout(resolve, 10));
  
  await Promise.race([evaluation, timeout]);
  console.log("race finished");
}

run();
