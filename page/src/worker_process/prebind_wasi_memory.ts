type WasiMemoryAnimal = {
  initialize_only(instance: {
    exports: { memory: WebAssembly.Memory };
  }): void;
};

export function prebindWasiMemory(
  animal: WasiMemoryAnimal,
  memory: WebAssembly.Memory,
): void {
  animal.initialize_only({ exports: { memory } });
}
