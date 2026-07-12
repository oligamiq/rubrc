export interface CratesProxyFetchOptions {
  /**
   * 例:
   * https://crates-cors-proxy.example.workers.dev
   */
  proxyBaseUrl: string | URL;

  /**
   * テスト時に差し替えるためのfetch実装。
   */
  fetchImpl?: typeof fetch;
}

function joinProxyPath(
  basePathname: string,
  targetPathname: string,
): string {
  const base = basePathname.replace(/\/+$/, "");
  const target = targetPathname.replace(/^\/+/, "");

  return `${base}/${target}`;
}

/**
 * crates.io関連のURLをCloudflare Workersプロキシへ変換します。
 *
 * 変換例:
 *
 * https://index.crates.io/config.json
 *   ↓
 * https://proxy.example.workers.dev/index/config.json
 *
 * https://crates.io/api/v1/crates/serde/1.0.219/download
 *   ↓
 * https://proxy.example.workers.dev/crates/serde/1.0.219/download
 *
 * crates.io以外へのリクエストは変更しません。
 */
export function createCratesProxyFetch(
  options: CratesProxyFetchOptions,
): typeof fetch {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const proxyBase = new URL(options.proxyBaseUrl);

  if (
    proxyBase.protocol !== "https:" &&
    proxyBase.protocol !== "http:"
  ) {
    throw new TypeError(
      `Unsupported proxy protocol: ${proxyBase.protocol}`,
    );
  }

  proxyBase.username = "";
  proxyBase.password = "";
  proxyBase.search = "";
  proxyBase.hash = "";
  proxyBase.pathname = proxyBase.pathname.replace(/\/+$/, "");

  function proxyUrl(pathname: string, search: string): string {
    const result = new URL(proxyBase);

    result.pathname = joinProxyPath(
      proxyBase.pathname,
      pathname,
    );
    result.search = search;
    result.hash = "";

    return result.href;
  }

  function transformUrl(value: string): string | null {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      // 相対URLなどは通常のfetchにそのまま渡します。
      return null;
    }

    if (
      url.protocol === "https:" &&
      url.host === "index.crates.io"
    ) {
      return proxyUrl(
        `/index${url.pathname}`,
        url.search,
      );
    }

    const cratesApiPrefix = "/api/v1/crates";

    if (
      url.protocol === "https:" &&
      url.host === "crates.io" &&
      (
        url.pathname === cratesApiPrefix ||
        url.pathname.startsWith(`${cratesApiPrefix}/`)
      )
    ) {
      const suffix = url.pathname.slice(cratesApiPrefix.length);

      return proxyUrl(
        `/crates${suffix}`,
        url.search,
      );
    }

    return null;
  }

  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    /*
     * Requestの場合は、initによる上書きを先に反映します。
     * body、headers、signal、credentialsなども維持されます。
     */
    if (input instanceof Request) {
      const originalRequest = new Request(input, init);
      const transformedUrl = transformUrl(originalRequest.url);

      if (transformedUrl === null) {
        return fetchImpl(originalRequest);
      }

      return fetchImpl(
        new Request(transformedUrl, originalRequest),
      );
    }

    const originalUrl = input instanceof URL ? input.href : input;

    const transformedUrl = transformUrl(originalUrl);

    if (transformedUrl === null) {
      return fetchImpl(input, init);
    }

    return fetchImpl(transformedUrl, init);
  }) as typeof fetch;
}
