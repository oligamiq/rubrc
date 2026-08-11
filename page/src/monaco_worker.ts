import * as monaco from "monaco-editor";
import editorWorker from "./workers/editor.worker.ts?worker";

monaco.languages.register({ id: "rust", extensions: [".rs"] });

// @ts-ignore
self.MonacoEnvironment = {
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  getWorker(_: any, _label: string) {
    return new editorWorker();
  },
};
