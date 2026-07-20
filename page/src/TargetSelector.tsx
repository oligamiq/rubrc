import { createSignal, onCleanup, onMount, For, createMemo } from "solid-js";

export const TargetSelector = (props: {
  options: string[];
  value: string | undefined;
  onChange: (val: string) => void;
}) => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  let dropdownRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const filteredOptions = createMemo(() => {
    const q = search().toLowerCase();
    return props.options.filter(o => o.toLowerCase().includes(q));
  });

  const handleClickOutside = (e: MouseEvent) => {
    if (dropdownRef && !dropdownRef.contains(e.target as Node)) {
      setIsOpen(false);
      setSearch("");
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
  });

  const handleOpen = () => {
    setIsOpen(!isOpen());
    if (isOpen()) {
      if (typeof window !== "undefined" && !('ontouchstart' in window) && navigator.maxTouchPoints === 0) {
        setTimeout(() => searchInputRef?.focus(), 50);
      }
    } else {
      setSearch("");
    }
  };

  return (
    <div class="relative w-full min-w-[140px] sm:min-w-[280px]" ref={dropdownRef}>
      <button
        type="button"
        onClick={handleOpen}
        class={`w-full flex items-center justify-between bg-gray-900/80 hover:bg-gray-800 border ${isOpen() ? 'border-green-500/50 ring-1 ring-green-500/50' : 'border-gray-700/50'} text-gray-200 text-sm rounded-lg px-4 py-2.5 transition-all duration-200 focus:outline-none focus:border-green-500/50 focus:ring-1 focus:ring-green-500/50 shadow-inner group`}
      >
        <span class="flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden pr-2">
          <svg class="w-4 h-4 text-green-600/70 group-hover:text-green-500 transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path>
          </svg>
          <span class="font-medium tracking-wide truncate">
            {props.value || "Select target..."}
          </span>
        </span>
        <svg 
          class={`w-4 h-4 text-gray-500 transition-transform duration-300 flex-shrink-0 ml-2 ${isOpen() ? 'rotate-180 text-green-500' : ''}`} 
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path>
        </svg>
      </button>

      {isOpen() && (
        <div class="absolute z-50 w-full bottom-full mb-2 bg-gray-900/95 backdrop-blur-md border border-gray-700/80 rounded-lg shadow-[0_-8px_30px_rgb(0,0,0,0.4)] overflow-hidden origin-bottom flex flex-col animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div class="p-2 border-b border-gray-700/50 bg-gray-900/50">
            <div class="relative">
              <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search target..."
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
                class="w-full bg-gray-950/50 text-gray-200 text-sm rounded-md pl-9 pr-3 py-2 border border-gray-700/50 focus:outline-none focus:border-green-500/50 focus:ring-1 focus:ring-green-500/50 placeholder-gray-500 transition-colors"
              />
            </div>
          </div>
          <div class="p-1.5 max-h-[40vh] sm:max-h-60 overflow-y-auto flex-1">
            <For each={filteredOptions()}>
              {(option) => (
                <button
                  type="button"
                  class={`w-full text-left px-3 py-2.5 rounded-md transition-all duration-150 flex items-center gap-3 ${
                    props.value === option 
                      ? 'bg-green-500/15 text-green-400 font-medium shadow-sm' 
                      : 'text-gray-300 hover:bg-gray-800 hover:text-gray-100'
                  }`}
                  onClick={() => {
                    props.onChange(option);
                    setIsOpen(false);
                    setSearch("");
                  }}
                >
                  <div class={`flex-shrink-0 w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                    props.value === option 
                      ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.8)] scale-110' 
                      : 'bg-transparent scale-0'
                  }`} />
                  <span class="truncate">{option}</span>
                </button>
              )}
            </For>
            {filteredOptions().length === 0 && (
              <div class="px-3 py-4 text-sm text-gray-500 text-center">
                No targets found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
