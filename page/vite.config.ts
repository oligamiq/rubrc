import { open, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solidPlugin from "vite-plugin-solid";

const crossOriginIsolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const developmentRustSrcDirectory = fileURLToPath(
  new URL("../.rubrc-cache/dev/", import.meta.url),
);
const developmentRustSrcSidecarPath = `${developmentRustSrcDirectory}/rust-src.sha256`;

type DevelopmentRustSrcAsset = {
  path: string;
  sha256: string;
};

async function readDevelopmentRustSrcAsset(): Promise<DevelopmentRustSrcAsset> {
  const sha256 = (await readFile(developmentRustSrcSidecarPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(
      `invalid development rust-src SHA-256 in ${developmentRustSrcSidecarPath}`,
    );
  }
  return {
    path: `${developmentRustSrcDirectory}/rust-src-${sha256}.tar.vfsbr`,
    sha256,
  };
}

function developmentRustSrcPlugin(asset: DevelopmentRustSrcAsset): Plugin {
  return {
    name: "rubrc-development-rust-src",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void serveDevelopmentRustSrcAsset(request, response, next, asset).catch(
          (error) => {
            if (!response.destroyed) next(error);
          },
        );
      });
    },
  };
}

async function serveDevelopmentRustSrcAsset(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  next: (error?: unknown) => void,
  asset: DevelopmentRustSrcAsset,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    next();
    return;
  }
  const rawUrl = request.url;
  if (!rawUrl?.startsWith("/") || rawUrl.startsWith("//")) {
    next();
    return;
  }
  const requestUrl = new URL(rawUrl, "http://localhost");
  if (requestUrl.pathname !== "/rust-src.tar.vfsbr") {
    next();
    return;
  }
  if (requestUrl.searchParams.get("v") !== asset.sha256) {
    response.statusCode = 409;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    const message = `rust-src development asset revision mismatch; expected ${asset.sha256}\n`;
    response.end(request.method === "HEAD" ? undefined : message);
    return;
  }

  const file = await open(asset.path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error(
        `development rust-src asset is not a regular file: ${asset.path}`,
      );
    }
    if (response.destroyed) {
      await file.close();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", String(stat.size));
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (request.method === "HEAD") {
      await file.close();
      if (!response.destroyed) response.end();
      return;
    }
  } catch (error) {
    await file.close();
    throw error;
  }
  let stream: ReturnType<typeof file.createReadStream>;
  try {
    stream = file.createReadStream();
  } catch (error) {
    await file.close();
    throw error;
  }
  try {
    await pipeline(stream, response);
  } catch (error) {
    if (
      response.destroyed ||
      (error instanceof Error &&
        "code" in error &&
        (error.code === "ECONNRESET" ||
          error.code === "ERR_STREAM_PREMATURE_CLOSE"))
    ) {
      return;
    }
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    throw error;
  }
}

export default defineConfig(async ({ command, isPreview }) => {
  const isDevelopmentServer = command === "serve" && isPreview !== true;
  const developmentRustSrcAsset = isDevelopmentServer
    ? await readDevelopmentRustSrcAsset()
    : undefined;
  const productionSourceRevision = process.env.SOURCE_SHA ?? "development";
  const sourceRevision =
    developmentRustSrcAsset?.sha256 ?? productionSourceRevision;

  return {
    define: {
      __RUBRC_SOURCE_REVISION__: JSON.stringify(sourceRevision),
      __RUBRC_BUILD_EPOCH__: JSON.stringify(process.env.BUILD_EPOCH ?? "0"),
    },
    resolve: {
      alias: {
        "monaco-editor": "@codingame/monaco-vscode-editor-api",
      },
      dedupe: [
        "vscode",
        "@codingame/monaco-vscode-api",
        "@codingame/monaco-vscode-extension-api",
        "@codingame/monaco-vscode-extensions-service-override",
      ],
    },
    plugins: [
      ...(developmentRustSrcAsset
        ? [developmentRustSrcPlugin(developmentRustSrcAsset)]
        : []),
      solidPlugin(),
      tailwindcss(),
    ],
    optimizeDeps: {
      exclude: ["brotli-dec-wasm"],
      esbuildOptions: {
        plugins: [importMetaUrlPlugin],
      },
    },
    server: {
      port: 3000,
      headers: crossOriginIsolationHeaders,
    },
    preview: { headers: crossOriginIsolationHeaders },
    build: {
      target: "esnext",
      minify: process.env.NODE_ENV === "production" ? true : false,
    },
    worker: {
      format: "es",
    },
    base: "./",
  };
});
