interface Env {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  BACKEND_API_ORIGIN?: string;
  BACKEND_API_FALLBACK_ORIGIN?: string;
  BACKEND_API_TIMEOUT_MS?: string;
  ALLOWED_ORIGINS?: string;
}

const STATIC_FALLBACKS: Record<string, { body: string; contentType: string }> = {
  '/robots.txt': { body: 'User-agent: *\nDisallow:', contentType: 'text/plain; charset=utf-8' },
  '/favicon.ico': { body: '', contentType: 'image/x-icon' },
};


const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const MIN_UPSTREAM_TIMEOUT_MS = 3_000;
const MAX_UPSTREAM_TIMEOUT_MS = 90_000;
const WEBHOOK_UPSTREAM_TIMEOUT_MS = 55_000;

const parseTimeoutMs = (raw: string | undefined) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.max(MIN_UPSTREAM_TIMEOUT_MS, Math.min(MAX_UPSTREAM_TIMEOUT_MS, Math.floor(parsed)));
};

const withTimeoutFetch = async (request: Request, timeoutMs: number) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('upstream-timeout'), timeoutMs);

  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const toJsonResponse = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const corsOrigin = resolveCorsOrigin(request.headers.get('origin'), allowedOrigins);

    if (STATIC_FALLBACKS[url.pathname]) {
      const fallback = STATIC_FALLBACKS[url.pathname];
      return new Response(fallback.body, {
        status: url.pathname === '/favicon.ico' ? 204 : 200,
        headers: {
          'content-type': fallback.contentType,
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    const isApiProxyPath = url.pathname.startsWith('/api/');
    const isWebhookProxyPath = url.pathname === '/webhook';

    if (isApiProxyPath || isWebhookProxyPath) {
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
      const baseTimeoutMs = parseTimeoutMs(env.BACKEND_API_TIMEOUT_MS);
      const timeoutMs = isWebhookProxyPath ? Math.max(baseTimeoutMs, WEBHOOK_UPSTREAM_TIMEOUT_MS) : baseTimeoutMs;
      const upstreamOrigins = [env.BACKEND_API_ORIGIN, env.BACKEND_API_FALLBACK_ORIGIN]
        .map((value) => value?.trim())
        .filter((value, index, arr): value is string => Boolean(value) && arr.indexOf(value) === index);

      let upstreamResponse: Response | null = null;
      let lastError: unknown = null;
      let selectedOrigin: string | null = null;

      for (const origin of upstreamOrigins) {
        const upstreamUrl = joinUrl(origin, upstreamPath, url.search);
        const upstreamRequest = buildProxyRequest(request, upstreamUrl);
        selectedOrigin = origin;

        try {
          upstreamResponse = await withTimeoutFetch(upstreamRequest, timeoutMs);
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!upstreamResponse) {
        return toJsonResponse(504, {
          error: 'Upstream unavailable',
          code: 'UPSTREAM_UNAVAILABLE',
          hint: 'Backend origin timed out or was unreachable. Check BACKEND_API_ORIGIN health.',
          timeoutMs,
          attemptedOrigins: upstreamOrigins,
          cause: String(lastError || 'unknown_error'),
        });
      }

      const responseHeaders = new Headers(upstreamResponse.headers);

      if (corsOrigin) {
        responseHeaders.set('Access-Control-Allow-Origin', corsOrigin);
        responseHeaders.set('Vary', 'Origin');
      }

      responseHeaders.set('x-proxied-by', 'cloudflare-worker-edge-proxy');
      responseHeaders.set('x-proxy-path-type', isWebhookProxyPath ? 'webhook' : 'api');
      if (selectedOrigin) {
        responseHeaders.set('x-proxy-upstream-origin', selectedOrigin);
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  },
};
