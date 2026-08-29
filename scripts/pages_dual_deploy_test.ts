function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Cloudflare source artifact omits mini-coi", async () => {
  const publish = await Deno.readTextFile("scripts/publish-pages-dist.sh");
  const prepare = await Deno.readTextFile("scripts/prepare-ci-pages-dist.sh");
  assert(!publish.includes("bunx mini-coi"), "publisher injects mini-coi");
  assert(
    !publish.includes('src="./mini-coi.js"'),
    "publisher injects mini-coi tag",
  );
  assert(!prepare.includes("bunx mini-coi"), "CI preparation injects mini-coi");
  assert(
    !prepare.includes('src="./mini-coi.js"'),
    "CI preparation injects mini-coi tag",
  );
});

Deno.test("GitHub Pages adds pinned mini-coi at deploy time", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/static.yml");
  assert(
    workflow.includes("npx --yes mini-coi@0.4.3 -sw site/mini-coi.js"),
    "GitHub Pages workflow lacks pinned mini-coi generation",
  );
  assert(
    workflow.includes('src="./mini-coi.js"'),
    "GitHub Pages workflow lacks mini-coi injection",
  );
});
