import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const LOCAL_CRATES_PROXY_PREFIX = "/__rubrc_crates_proxy";

const REQUEST_HEADERS = [
  "accept",
  "if-modified-since",
  "if-none-match",
  "range",
  "cargo-protocol",
];
const RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

function fixedOriginUrl(origin, pathname, search = "") {
  const target = new URL(origin);
  target.pathname = pathname;
  target.search = search;
  return target;
}

export function resolveLocalCratesProxyTarget(rawUrl) {
  let requestUrl;
  try {
    requestUrl = new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return null;
  }

  const indexPrefix = `${LOCAL_CRATES_PROXY_PREFIX}/index`;
  if (
    requestUrl.pathname === indexPrefix ||
    requestUrl.pathname.startsWith(`${indexPrefix}/`)
  ) {
    const suffix = requestUrl.pathname.slice(indexPrefix.length) || "/";
    return fixedOriginUrl(
      "https://index.crates.io",
      suffix,
      requestUrl.search,
    );
  }

  const cratePrefix = `${LOCAL_CRATES_PROXY_PREFIX}/crates/`;
  if (!requestUrl.pathname.startsWith(cratePrefix)) return null;
  const suffix = requestUrl.pathname.slice(cratePrefix.length);
  const match = suffix.match(/^([^/]+)\/([^/]+)\/download$/);
  if (!match) return null;

  let crate;
  let version;
  try {
    crate = decodeURIComponent(match[1]);
    version = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(crate)) return null;
  if (!/^[0-9A-Za-z.+_-]{1,128}$/.test(version)) return null;

  return fixedOriginUrl(
    "https://static.crates.io",
    `/crates/${encodeURIComponent(crate)}/${encodeURIComponent(crate)}-${
      encodeURIComponent(version)
    }.crate`,
  );
}

const LOCAL_CRATE_DOWNLOAD_TEMPLATE =
  "https://crates.io/api/v1/crates/{crate}/{version}/download";

function writeText(request, response, status, text) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(request.method === "HEAD" ? undefined : text);
}

async function writeLocalIndexConfig(request, response, upstream) {
  if (request.method === "HEAD") {
    response.statusCode = upstream.status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end();
    return;
  }

  let config;
  try {
    config = await upstream.json();
  } catch (error) {
    console.error("Local crates proxy index config was invalid JSON", error);
    writeText(request, response, 502, "Bad Gateway\n");
    return;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    writeText(request, response, 502, "Bad Gateway\n");
    return;
  }

  config.dl = LOCAL_CRATE_DOWNLOAD_TEMPLATE;
  config["auth-required"] ??= false;
  const body = JSON.stringify(config);
  response.statusCode = upstream.status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=300");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.end(body);
}

export async function handleLocalCratesProxyRequest(
  request,
  response,
  { fetchImpl = globalThis.fetch } = {},
) {
  const rawUrl = request.url ?? "/";
  let requestUrl;
  try {
    requestUrl = new URL(rawUrl, "http://localhost");
  } catch {
    return false;
  }
  if (
    requestUrl.pathname !== LOCAL_CRATES_PROXY_PREFIX &&
    !requestUrl.pathname.startsWith(`${LOCAL_CRATES_PROXY_PREFIX}/`)
  ) {
    return false;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    writeText(request, response, 405, "Method Not Allowed\n");
    return true;
  }

  const target = resolveLocalCratesProxyTarget(rawUrl);
  if (target === null) {
    writeText(request, response, 404, "Not Found\n");
    return true;
  }

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }

  let upstream;
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      redirect: "follow",
    });
  } catch (error) {
    console.error("Local crates proxy upstream request failed", error);
    writeText(request, response, 502, "Bad Gateway\n");
    return true;
  }

  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (
    target.origin === "https://index.crates.io" &&
    target.pathname === "/config.json"
  ) {
    await writeLocalIndexConfig(request, response, upstream);
    return true;
  }

  response.statusCode = upstream.status;
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) response.setHeader(name, value);
  }
  if (request.method === "HEAD" || upstream.body === null) {
    response.end();
    return true;
  }

  await pipeline(Readable.fromWeb(upstream.body), response);
  return true;
}
