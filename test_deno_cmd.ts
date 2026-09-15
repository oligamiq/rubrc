const output = await new Deno.Command("ls", { args: ["-l"] }).output();
console.log(output.success);
