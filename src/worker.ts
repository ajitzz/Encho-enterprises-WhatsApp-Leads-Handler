interface Env {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  BACKEND_API_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
  UPSTREAM_TIMEOUT_MS?: string;
}

const joinUrl = (base: string, pathname: string, search: string) => {
  const normalizedBase = base.replace(/\/$/, '');
  return `${normalizedBase}${pathname}${search}`;
};

const parseAllowedOrigins = (raw: string | undefined) =>
  String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const resolveCorsOrigin = (origin: string | null, allowed: string[]) => {
  if (!origin) return '*';
  if (allowed.includes('*')) return '*';
  return allowed.includes(origin) ? origin : null;
};

const buildProxyRequest = (request: Request, destinationUrl: string) => {
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', new URL(request.url).host);
  headers.set('x-forwarded-proto', 'https');

  return new Request(destinationUrl, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });
};

const resolveUpstreamTimeoutMs = (raw: string | undefined) => {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 15_000;
  return Math.min(parsed, 60_000);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const corsOrigin = resolveCorsOrigin(request.headers.get('origin'), allowedOrigins);

    const isApiProxyPath = url.pathname.startsWith('/api/');
    const isWebhookProxyPath = url.pathname === '/webhook';
    const isTasksProxyPath = url.pathname.startsWith('/tasks/');

    if (isApiProxyPath || isWebhookProxyPath || isTasksProxyPath) {
      if (request.method === 'OPTIONS') {
        if (!corsOrigin) {
          return new Response('CORS origin not allowed', { status: 403 });
        }

        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': corsOrigin,
            'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers') || 'authorization,content-type',
            'Access-Control-Max-Age': '86400',
            Vary: 'Origin',
          },
        });
      }

      if (!env.BACKEND_API_ORIGIN) {
        return new Response(
          JSON.stringify({
            error: 'BACKEND_API_ORIGIN is missing',
            hint: 'Set BACKEND_API_ORIGIN in Worker variables to your Node backend URL.',
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      const upstreamPath = isWebhookProxyPath ? '/api/webhook' : url.pathname;
      const upstreamUrl = joinUrl(env.BACKEND_API_ORIGIN, upstreamPath, url.search);
      const upstreamRequest = buildProxyRequest(request, upstreamUrl);
      const upstreamTimeoutMs = resolveUpstreamTimeoutMs(env.UPSTREAM_TIMEOUT_MS);
      let upstreamResponse: Response;

      try {
        upstreamResponse = await fetch(upstreamRequest, {
          signal: AbortSignal.timeout(upstreamTimeoutMs),
        });
      } catch (error) {
        const code = error instanceof Error && error.name === 'TimeoutError' ? 504 : 502;
        return new Response(
          JSON.stringify({
            error: 'Upstream backend unavailable',
            path: url.pathname,
            upstream: upstreamUrl,
            timeoutMs: upstreamTimeoutMs,
          }),
          {
            status: code,
            headers: {
              'content-type': 'application/json',
              'x-proxied-by': 'cloudflare-worker-edge-proxy',
              'x-proxy-path-type': isWebhookProxyPath ? 'webhook' : isTasksProxyPath ? 'tasks' : 'api',
            },
          },
        );
      }
      const responseHeaders = new Headers(upstreamResponse.headers);

      if (corsOrigin) {
        responseHeaders.set('Access-Control-Allow-Origin', corsOrigin);
        responseHeaders.set('Vary', 'Origin');
      }

      responseHeaders.set('x-proxied-by', 'cloudflare-worker-edge-proxy');
      const proxyPathType = isWebhookProxyPath ? 'webhook' : isTasksProxyPath ? 'tasks' : 'api';
      responseHeaders.set('x-proxy-path-type', proxyPathType);

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    if (env.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
