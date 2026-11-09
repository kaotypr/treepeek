import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

export const APP_SCHEME = "app";
export const APP_HOST = "treepeek";
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/**
 * The content security policy for every page: only the app's own files, no eval, no
 * remote origins, no plugins, no framing.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** Must run before `app` is ready: `app://` behaves like a secure, standard origin. */
export function registerAppSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ]);
}

/** True for a URL served by this app's own scheme. */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/**
 * Serves `app://treepeek/<path>` from the renderer build folder and nothing else. Every
 * response carries the CSP header.
 */
export function registerAppProtocol(rendererDir: string): void {
  const root = resolve(rendererDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return textResponse(404, "Not found");

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return textResponse(400, "Bad request");
    }
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const filePath = resolve(root, `.${pathname}`);
    const rel = relative(root, filePath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return textResponse(403, "Forbidden");
    }

    let upstream: Response;
    try {
      upstream = await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return textResponse(404, "Not found");
    }
    if (!upstream.ok) return textResponse(404, "Not found");

    const headers = new Headers(upstream.headers);
    headers.set("Content-Type", MIME_TYPES[extname(filePath)] ?? "application/octet-stream");
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, { status: 200, headers });
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    },
  });
}
