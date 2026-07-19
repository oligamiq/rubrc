import { compile_and_run, download } from "./compile_and_run";

export const RunButton = (props: {
  triple: string;
}) => {
  return (
    <button
      type="button"
      onClick={() => {
        console.log("run button clicked");
        compile_and_run(props.triple);
      }}
      class="w-full justify-center px-4 py-2.5 bg-green-600/90 hover:bg-green-500 text-white text-sm font-semibold rounded-lg shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-green-500/60 flex items-center gap-2 whitespace-nowrap"
    >
      <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
      <span class="hidden sm:inline">Compile and Run</span>
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
      class="w-full justify-center px-4 py-2.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm font-medium rounded-lg shadow-sm transition-all duration-200 focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500 flex items-center gap-2 whitespace-nowrap"
    >
      <svg class="w-4 h-4 text-gray-400 group-hover:text-white flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
      <span class="hidden sm:inline">Download</span>
    </button>
  );
};
