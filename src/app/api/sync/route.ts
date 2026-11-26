import { NextResponse, type NextRequest } from 'next/server';

function getAllowedOrigins(req: NextRequest): Set<string> {
  const configured = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  configured.push(req.nextUrl.origin);
  return new Set(configured);
}

/**
 * Endpoint API Mutasi Sinkronisasi dengan Verifikasi Origin Tanpa Toleransi (OWASP Hardening).
 * Menolak setiap permintaan POST tanpa header Origin resmi dengan HTTP 403.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  const allowedOrigins = getAllowedOrigins(req);

  if (!origin || !allowedOrigins.has(origin)) {
    return NextResponse.json(
      { error: 'FORBIDDEN_ORIGIN', message: 'Origin permintaan tidak diizinkan.' },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'INVALID_JSON', message: 'Payload JSON tidak valid.' },
      { status: 400 }
    );
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { events?: unknown }).events)
  ) {
    return NextResponse.json(
      { error: 'INVALID_SCHEMA', message: 'Atribut events wajib berupa array.' },
      { status: 400 }
    );
  }

  const events = (body as { events: Array<{ id?: unknown; qty_delta?: unknown }> }).events;
  if (events.length > 500) {
    return NextResponse.json(
      { error: 'BATCH_TOO_LARGE', message: 'Maksimal 500 event per batch sinkronisasi.' },
      { status: 400 }
    );
  }

  for (const ev of events) {
    if (
      typeof ev.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ev.id)
    ) {
      return NextResponse.json(
        { error: 'INVALID_EVENT_UUID', message: 'Setiap event wajib memiliki kunci idempotensi UUIDv7 yang sah.' },
        { status: 400 }
      );
    }
  }

  return NextResponse.json(
    {
      status: 'VALIDATED',
      acceptedCount: events.length,
      serverTimestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
