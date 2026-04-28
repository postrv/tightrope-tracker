/**
 * Zero-dependency URL router for the public API.
 *
 * Pattern syntax: plain string paths only (no param captures yet). We match on
 * exact pathname + method. Query strings are stripped by the matcher and read
 * by handlers off the Request URL. That is all the router has to do.
 */

export type Method = "GET" | "POST" | "OPTIONS" | "HEAD";

export type Handler = (
  req: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

interface Route {
  method: Method;
  path: string;
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];
  private notFoundHandler: Handler = () => json({ error: "not_found", code: "NOT_FOUND" }, 404);
  /** path → set of allowed concrete methods (excluding OPTIONS, which is universal). */
  private readonly methodsByPath: Map<string, Set<Method>> = new Map();

  get(path: string, handler: Handler): this {
    return this.register("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.register("POST", path, handler);
  }

  options(path: string, handler: Handler): this {
    this.routes.push({ method: "OPTIONS", path, handler });
    return this;
  }

  private register(method: Method, path: string, handler: Handler): this {
    this.routes.push({ method, path, handler });
    let set = this.methodsByPath.get(path);
    if (!set) {
      set = new Set();
      this.methodsByPath.set(path, set);
    }
    set.add(method);
    return this;
  }

  notFound(handler: Handler): this {
    this.notFoundHandler = handler;
    return this;
  }

  /**
   * Returns the handler for the given request, or null if no route matches.
   * Exposed for testing.
   */
  match(method: string, pathname: string): Handler | null {
    for (const route of this.routes) {
      if (route.method === method && route.path === pathname) return route.handler;
    }
    return null;
  }

  /** True if the path has any concrete method registered (not just OPTIONS). */
  hasOptions(pathname: string): boolean {
    return this.methodsByPath.has(pathname);
  }

  /**
   * All registered paths for the given method, in registration order.
   * Used by the OpenAPI drift-guard test to assert every route is
   * documented and vice versa.
   */
  listPaths(method: Method = "GET"): readonly string[] {
    return this.routes.filter((r) => r.method === method).map((r) => r.path);
  }

  /** Comma-joined Allow header for a known path: "GET, OPTIONS" or "POST, OPTIONS" etc. */
  private allowHeader(pathname: string): string {
    const set = this.methodsByPath.get(pathname);
    if (!set) return "OPTIONS";
    const ordered: Method[] = (["GET", "POST"] as Method[]).filter((m) => set.has(m));
    ordered.push("OPTIONS");
    return ordered.join(", ");
  }

  async handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    const direct = this.match(method, url.pathname);
    if (direct) return direct(req, env, ctx);

    // CORS preflight for any registered path (regardless of method).
    if (method === "OPTIONS" && this.hasOptions(url.pathname)) {
      // Note: handlers can override by registering an OPTIONS route explicitly.
      const optionsRoute = this.match("OPTIONS", url.pathname);
      if (optionsRoute) return optionsRoute(req, env, ctx);
      return preflight(this.allowHeader(url.pathname));
    }

    // Method not allowed on an existing path.
    if (this.methodsByPath.has(url.pathname)) {
      return json({ error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" }, 405, {
        Allow: this.allowHeader(url.pathname),
      });
    }

    return this.notFoundHandler(req, env, ctx);
  }
}

// --- Response helpers ------------------------------------------------------

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60, s-maxage=300",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()",
  "Vary": "Origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Frame-Options": "DENY",
};

export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = { ...JSON_HEADERS, ...extraHeaders };
  // Error responses must never be cached by intermediaries: otherwise a
  // transient 500 can stick to an edge cache for the full s-maxage window.
  if (status >= 400) headers["Cache-Control"] = "no-store";
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

/**
 * 503 NOT_SEEDED -- returned by handlers when the snapshot looks like an
 * empty-seed placeholder rather than real data. Distinct from a 500
 * `INTERNAL`: this means ingestion has not yet run, not that the DB is broken.
 */
export function notSeeded(): Response {
  return json(
    { code: "NOT_SEEDED", message: "Data has not been ingested yet" },
    503,
  );
}

export function preflight(allowMethods = "GET, OPTIONS"): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": allowMethods,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
