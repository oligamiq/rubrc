import { validateTarEntryName } from "./scripts/sysroot_cache.ts";
try {
  console.log(validateTarEntryName("./"));
} catch (e) {
  console.log(e.message);
}
