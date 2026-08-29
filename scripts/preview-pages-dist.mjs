import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  closeBrowserStaticServer,
  startBrowserStaticServer,
} from "./lsp_browser_static_server.mjs";

const artifactDirectory = process.argv[2];
if (!artifactDirectory) {
  console.error("Usage: bun run pages:preview -- <artifact-directory>");
  process.exit(2);
}

const rootDirectory = resolve(artifactDirectory);
const indexPath = resolve(rootDirectory, "index.html");
const indexStat = await stat(indexPath).catch(() => null);
if (!indexStat?.isFile()) {
  console.error(`Error: ${indexPath} does not exist or is not a file`);
  process.exit(2);
}

const port = Number(process.env.PORT ?? "4173");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`invalid static server port: ${process.env.PORT}`);
}

const server = await startBrowserStaticServer({ rootDirectory, port });
console.log(`Serving ${rootDirectory}`);
console.log(`Open http://127.0.0.1:${port}`);

const shutdown = () => void closeBrowserStaticServer(server);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
