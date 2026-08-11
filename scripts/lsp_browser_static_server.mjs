import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("../page/dist/", import.meta.url));
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".json", "application/json; charset=utf-8"],
  [".vfsbr", "application/octet-stream"],
]);

function isMissing(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isClientAbort(error, request, response) {
  return (
    request.destroyed ||
    response.destroyed ||
    (error instanceof Error &&
      "code" in error &&
      (error.code === "ECONNRESET" ||
        error.code === "ERR_STREAM_PREMATURE_CLOSE"))
  );
}

function endResponse(request, response, body = "") {
  response.end(request.method === "HEAD" ? undefined : body);
}

export function resolveStaticPath(rootDirectory, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\0")
  ) {
    return null;
  }
  const normalized = decoded.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return null;

  const root = resolve(rootDirectory);
  const candidate = resolve(root, `.${normalized}`);
  const relativePath = relative(root, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return candidate;
}

async function regularFile(path) {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile() ? fileStat : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function serveFile(request, response, path, fileStat) {
  response.statusCode = 200;
  response.setHeader(
    "Content-Type",
    CONTENT_TYPES.get(extname(path).toLowerCase()) ??
      "application/octet-stream",
  );
  response.setHeader("Content-Length", String(fileStat.size));
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  try {
    await pipeline(createReadStream(path), response);
  } catch (error) {
    if (isClientAbort(error, request, response)) return;
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    throw error;
  }
}

async function handleRequest(rootDirectory, request, response) {
  for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
    response.setHeader(name, value);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.setHeader("Allow", "GET, HEAD");
    endResponse(request, response, "Method Not Allowed\n");
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(request.url ?? "/", "http://localhost");
  } catch {
    response.statusCode = 400;
    endResponse(request, response, "Bad Request\n");
    return;
  }
  const pathname =
    requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const requestedPath = resolveStaticPath(rootDirectory, pathname);
  if (requestedPath === null) {
    response.statusCode = 400;
    endResponse(request, response, "Bad Request\n");
    return;
  }

  const requestedStat = await regularFile(requestedPath);
  if (requestedStat !== null) {
    await serveFile(request, response, requestedPath, requestedStat);
    return;
  }

  const fallbackPath = resolve(rootDirectory, "index.html");
  const fallbackStat = await regularFile(fallbackPath);
  if (fallbackStat === null) {
    response.statusCode = 404;
    endResponse(request, response, "Not Found\n");
    return;
  }
  await serveFile(request, response, fallbackPath, fallbackStat);
}

export function createBrowserStaticServer(rootDirectory = DEFAULT_ROOT) {
  const root = resolve(rootDirectory);
  return createServer((request, response) => {
    void handleRequest(root, request, response).catch((error) => {
      if (isClientAbort(error, request, response)) return;
      console.error("Browser static server request failed", error);
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 500;
      endResponse(request, response, "Internal Server Error\n");
    });
  });
}

export async function startBrowserStaticServer({
  rootDirectory = DEFAULT_ROOT,
  hostname = "127.0.0.1",
  port = 4173,
} = {}) {
  const server = createBrowserStaticServer(rootDirectory);
  await new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, hostname, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
  return server;
}

export async function closeBrowserStaticServer(server) {
  if (!server?.listening) return;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
    server.closeAllConnections?.();
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? "4173");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid static server port: ${process.env.PORT}`);
  }
  const server = await startBrowserStaticServer({ port });
  console.log(`browser static server listening on http://127.0.0.1:${port}`);
  const shutdown = () => void closeBrowserStaticServer(server);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
