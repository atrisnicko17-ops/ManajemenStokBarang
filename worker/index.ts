export interface WorkerEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  ALLOWED_ORIGINS?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
}

const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' blob: data: https://xlnimeszzyaryntlplcn.supabase.co https://*.supabase.co",
  "connect-src 'self' https://xlnimeszzyaryntlplcn.supabase.co wss://xlnimeszzyaryntlplcn.supabase.co https://*.supabase.co wss://*.supabase.co",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Content-Security-Policy', CSP_POLICY],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload'],
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()'],
];

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of SECURITY_HEADERS) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(payload: unknown, status: number): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  );
}

function isAllowedOrigin(request: Request, env: WorkerEnv): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;

  const url = new URL(request.url);
  const allowlist = new Set<string>([url.origin]);
  if (env.ALLOWED_ORIGINS) {
    for (const item of env.ALLOWED_ORIGINS.split(',')) {
      const trimmed = item.trim();
      if (trimmed) allowlist.add(trimmed);
    }
  }
  return allowlist.has(origin);
}

const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    // Endpoint mutasi Edge dengan Verifikasi Origin Tanpa Toleransi (HTTP 403)
    if (url.pathname === '/api/sync') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
      }

      if (!isAllowedOrigin(request, env)) {
        return jsonResponse(
          { error: 'FORBIDDEN_ORIGIN', message: 'Origin permintaan tidak diizinkan.' },
          403
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          { error: 'INVALID_JSON', message: 'Payload JSON tidak valid.' },
          400
        );
      }

      if (
        typeof body !== 'object' ||
        body === null ||
        !Array.isArray((body as { events?: unknown }).events)
      ) {
        return jsonResponse(
          { error: 'INVALID_SCHEMA', message: 'Atribut events wajib berupa array.' },
          400
        );
      }

      const events = (body as { events: Array<{ id?: unknown }> }).events;
      if (events.length > 500) {
        return jsonResponse(
          { error: 'BATCH_TOO_LARGE', message: 'Maksimal 500 event per batch.' },
          400
        );
      }

      for (const ev of events) {
        if (typeof ev.id !== 'string' || !UUID_V7_REGEX.test(ev.id)) {
          return jsonResponse(
            {
              error: 'INVALID_EVENT_UUID',
              message: 'Setiap event wajib memiliki kunci idempotensi UUIDv7 yang sah.',
            },
            400
          );
        }
      }

      return jsonResponse(
        {
          status: 'VALIDATED',
          acceptedCount: events.length,
          serverTimestamp: new Date().toISOString(),
        },
        200
      );
    }

    const assetResponse = await env.ASSETS.fetch(request);
    return withSecurityHeaders(assetResponse);
  },
};
