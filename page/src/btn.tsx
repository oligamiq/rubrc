import { compile_and_run, download } from "./compile_and_run";
import { createRunAfterFlush } from "./run_after_flush";

export const RunButton = (props: {
  triple?: string;
  flush: () => Promise<void>;
}) => {
  const run = createRunAfterFlush(props.flush, compile_and_run, console.error);
  return (
    <button
      type="button"
      onClick={() => {
        console.log("run button clicked");
        void run(props.triple);
      }}
      class="text-2xl text-green-700"
    >
      Compile and Run
    </button>
  );
};

export const DownloadButton = () => {
  return (
    <button
      type="button"
      onClick={() => {
        console.log("download button clicked");
        download("/target/wasm32-wasip1/debug/main.wasm");
      }}
      class="text-2xl text-green-700"
    >
      Download file
    </button>
  );
};
