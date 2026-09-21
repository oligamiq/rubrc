import textMateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker";
import editorWorker from "./workers/editor.worker.ts?worker";

// @ts-ignore
self.MonacoEnvironment = {
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  getWorker(_: any, label: string) {
    if (label === "TextMateWorker") return new textMateWorker();
    return new editorWorker();
  },
};
