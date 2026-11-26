import {profileHostImports} from './host_import_profile.mjs';

// Used only in an isolated diagnostic preview. Install before any Wasm instantiation
// in EACH realm (page and workers); never use these timings as acceptance results.
export function installHostImportProfile(realm, profiler, {sampleEvery = 1024} = {}) {
  const wasm = realm.WebAssembly;
  if (!wasm || realm.__rubrcHostImports) throw new Error('missing WebAssembly or profiler already installed');
  const original = {Instance: wasm.Instance, instantiate: wasm.instantiate, instantiateStreaming: wasm.instantiateStreaming};
  const instances = [];
  const now = realm.performance.now.bind(realm.performance);
  function instrument(imports) {
    if (imports == null) return imports;
    const descriptors = [];
    for (const [module, namespace] of Object.entries(imports)) {
      for (const [name, value] of Object.entries(namespace)) {
        if (typeof value === 'function') descriptors.push({module, name, kind:'function'});
      }
    }
    if (instances.length >= 256) throw new Error('diagnostic import profiler instance limit');
    const p = profiler(imports, descriptors, {now, sampleEvery});
    instances.push(p);
    return p.imports;
  }
  wasm.Instance = new Proxy(original.Instance, {
    construct(target, args, newTarget) {
      const [module, imports] = args;
      return Reflect.construct(target, [module, instrument(imports)], newTarget);
    },
  });
  wasm.instantiate = function(source, imports) {
    return Reflect.apply(original.instantiate, wasm, [source, instrument(imports)]);
  };
  if (original.instantiateStreaming) wasm.instantiateStreaming = function(source, imports) {
    return Reflect.apply(original.instantiateStreaming, wasm, [source, instrument(imports)]);
  };
  const api = {
    snapshot: () => ({realm: String(realm.location?.href ?? 'unknown'), sampleEvery,
      instances: instances.map((p, id) => ({id, ...p.snapshot()}))}),
    restore() {
      // Already instantiated functions remain wrapped; restore only affects future creation.
      wasm.Instance = original.Instance;
      wasm.instantiate = original.instantiate;
      if (original.instantiateStreaming) wasm.instantiateStreaming = original.instantiateStreaming;
      delete realm.__rubrcHostImports;
    },
  };
  realm.__rubrcHostImports = api;
  return api;
}

export function hostImportBootstrapSource(options = {}) {
  return `;(${installHostImportProfile.toString()})(globalThis, (${profileHostImports.toString()}), ${JSON.stringify(options)});\n`;
}
