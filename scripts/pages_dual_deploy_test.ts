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

Deno.test("CI preview backfills legacy assets and preserves modern ones", async () => {
  const root = await Deno.realPath(".");
  const temporary = await Deno.makeTempDir();
  const fakeBin = `${temporary}/bin`;
  const denoCwdLog = `${temporary}/deno-cwd.log`;
  const decoder = new TextDecoder();

  const writeFixture = async (directory: string) => {
    await Deno.mkdir(`${directory}/assets`, { recursive: true });
    await Deno.mkdir(`${directory}/v1`, { recursive: true });
    await Deno.writeTextFile(
      `${directory}/index.html`,
      "<main>fixture</main>\n",
    );
    await Deno.writeTextFile(`${directory}/v1/index.html`, "<main>v1</main>\n");
    await Deno.writeTextFile(
      `${directory}/assets/vfs.core-test.wasm.br.part-000`,
      "x",
    );
    await Deno.writeTextFile(
      `${directory}/assets/vfs.core-test.wasm.br.json`,
      JSON.stringify({
        version: 1,
        encoding: "br",
        originalFile: "vfs.core-test.wasm",
        originalSize: 1,
        compressedSize: 1,
        parts: [{ file: "vfs.core-test.wasm.br.part-000", size: 1 }],
      }),
    );
  };

  const runPrepare = async (artifact: string) => {
    const result = await new Deno.Command("bash", {
      cwd: temporary,
      args: [
        "-c",
        'PATH="$1:$PATH" FAKE_DENO_CWD_FILE="$2" bash "$3" "$4"',
        "rubrc-test",
        fakeBin,
        denoCwdLog,
        `${root}/scripts/prepare-ci-pages-dist.sh`,
        artifact,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      result.success,
      `CI preparation failed:\n${decoder.decode(result.stdout)}${
        decoder.decode(result.stderr)
      }`,
    );
  };

  try {
    await Deno.mkdir(fakeBin, { recursive: true });
    const fakeDeno = `${fakeBin}/deno`;
    await Deno.writeTextFile(
      fakeDeno,
      '#!/bin/sh\nset -eu\nprintf "%s\\n" "$PWD" >> "$FAKE_DENO_CWD_FILE"\nfor last do :; done\nprintf "fake-rust-src" > "$last"\n',
    );
    await Deno.chmod(fakeDeno, 0o755);

    const legacy = `${temporary}/legacy`;
    await writeFixture(legacy);
    await Deno.writeTextFile(`${legacy}/.rubrc-pages-build.json`, "");
    await runPrepare(legacy);
    const legacyOutput = `${legacy}-pages-ready`;
    assert(
      (await Deno.readTextFile(`${legacyOutput}/rust-src.tar.vfsbr`)) ===
        "fake-rust-src",
      "legacy rust-src was not backfilled",
    );
    assert(
      (await Deno.readTextFile(`${legacyOutput}/.rubrc-pages-build.json`)) ===
        "{}\n",
      "legacy metadata was not backfilled with inert JSON",
    );

    const modern = `${temporary}/modern`;
    await writeFixture(modern);
    const metadata = '{"version":1,"sourceSha":"keep-me","buildEpoch":42}\n';
    await Deno.writeTextFile(`${modern}/rust-src.tar.vfsbr`, "keep-rust-src");
    await Deno.writeTextFile(`${modern}/.rubrc-pages-build.json`, metadata);
    await runPrepare(modern);
    const modernOutput = `${modern}-pages-ready`;
    assert(
      (await Deno.readTextFile(`${modernOutput}/rust-src.tar.vfsbr`)) ===
        "keep-rust-src",
      "modern rust-src was overwritten",
    );
    assert(
      (await Deno.readTextFile(`${modernOutput}/.rubrc-pages-build.json`)) ===
        metadata,
      "modern deployment metadata was overwritten",
    );
    assert(
      (await Deno.readTextFile(denoCwdLog)) === `${root}\n`,
      "rust-src preparation did not run from the repository root",
    );
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
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
