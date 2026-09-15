set -e
sed -i '/patchedDependencies/d; /patches\/@oligami%252Fbrowser_wasi_shim-threads@0.4.1.patch/d; /patches\/@oligami%2Fbrowser_wasi_shim-threads@0.4.1.patch/d' package.json
rm -rf patches node_modules/@oligami/browser_wasi_shim-threads
bun install --frozen-lockfile
bun patch @oligami/browser_wasi_shim-threads@0.4.1

if [ -f node_modules/@oligami/browser_wasi_shim-threads/src/destroyer_handle.test.ts ]; then
  cp node_modules/@oligami/browser_wasi_shim-threads/src/destroyer_handle.test.ts /tmp/orig_destroyer_handle.test.ts
else
  rm -f /tmp/orig_destroyer_handle.test.ts
fi

cp -a /tmp/opencode/browser_wasi_shim-af935/threads/src/. node_modules/@oligami/browser_wasi_shim-threads/src/
cp -a /tmp/opencode/browser_wasi_shim-af935/threads/dist/. node_modules/@oligami/browser_wasi_shim-threads/dist/

if [ -f /tmp/orig_destroyer_handle.test.ts ]; then
  cp /tmp/orig_destroyer_handle.test.ts node_modules/@oligami/browser_wasi_shim-threads/src/destroyer_handle.test.ts
else
  rm -f node_modules/@oligami/browser_wasi_shim-threads/src/destroyer_handle.test.ts
fi

rm -f node_modules/@oligami/browser_wasi_shim-threads/src/shared_array_buffer/worker_background/worker_background_destroy.test.ts

mkdir -p src/shared_array_buffer/worker_background
chmod -R 755 src

bun patch --commit node_modules/@oligami/browser_wasi_shim-threads
rm -rf src
