/** Cloudflare Worker entry point for the Waitland web application. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

function realtimeOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && localHost))
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function multiplayerConfig(request: Request, env: Env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const configured = Boolean(env.REALTIME_ORIGIN);
  const origin = realtimeOrigin(env.REALTIME_ORIGIN);
  const body = JSON.stringify({
    enabled: Boolean(origin),
    protocolVersion: 1,
    ...(origin ? { realtimeOrigin: origin } : {}),
    ...(!origin
      ? { reason: configured ? "invalid-configuration" : "not-configured" }
      : {}),
  });
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === "www.waitland.app") {
      url.hostname = "waitland.app";
      return Response.redirect(url.toString(), 308);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json(
        { ok: true, service: "waitland-web" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const imageFormat = format as
            | "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp"
            | "image/avif";
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format: imageFormat, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (url.pathname === "/api/multiplayer/config") {
      return multiplayerConfig(request, env);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker satisfies ExportedHandler<Env>;
