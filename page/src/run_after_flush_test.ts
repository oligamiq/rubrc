import source from "./btn.tsx" with { type: "text" };

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("RunButton uses native disabled state and suppresses disabled clicks", async () => {
  assert(source.includes("disabled: boolean"), "RunButton lacks disabled prop");
  assert(
    source.includes("disabled={props.disabled}"),
    "button is not natively disabled",
  );
  assert(
    /onClick=\{\(\)\s*=>\s*\{[\s\S]*?if \(!props\.disabled\)[\s\S]*?void props\.run\(props\.triple\)/
      .test(
        source,
      ),
    "disabled click can dispatch compile and run",
  );
  assert(
    source.includes("disabled:cursor-not-allowed") &&
      source.includes("disabled:opacity-50"),
    "disabled button lacks disabled styling",
  );
});

Deno.test("DownloadButton dispatches through its runtime-owned command", () => {
  assert(
    source.includes("download(file: string): Promise<void>"),
    "DownloadButton lacks a runtime download command",
  );
  assert(
    source.includes('void props.download("/target/wasm32-wasip1/debug/main.wasm")'),
    "DownloadButton bypasses its runtime-owned command",
  );
  assert(
    !source.includes('import { download } from "./compile_and_run"'),
    "DownloadButton still calls the unowned global adapter",
  );
});
