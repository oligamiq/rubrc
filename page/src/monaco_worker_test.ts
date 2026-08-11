const source = await Deno.readTextFile(
  new URL("./monaco_worker.ts", import.meta.url),
);
const editorWorkerSource = await Deno.readTextFile(
  new URL("./workers/editor.worker.ts", import.meta.url),
);

Deno.test("Monaco worker setup avoids empty aliased language workers", () => {
  if (source.includes("monaco-editor/esm/vs/language/")) {
    throw new Error(
      "the CodinGame monaco-editor alias exports language workers as empty modules",
    );
  }
  if (!source.includes("./workers/editor.worker.ts?worker")) {
    throw new Error("the local Monaco editor worker import is missing");
  }
  if (
    !editorWorkerSource.includes("monaco-editor/esm/vs/editor/editor.worker.js")
  ) {
    throw new Error("the base Monaco editor worker import is missing");
  }
});
