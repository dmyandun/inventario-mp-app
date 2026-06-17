import { NextResponse } from "next/server";

// Persiste y consulta los planes de distribucion aprobados en Supabase.
// Usa el service_role key SOLO en el servidor (nunca se expone al cliente).
// Si faltan las variables responde ok:false con un mensaje, igual que las otras
// rutas (telegram/email), para no romper la app sin configurar.

const TABLE = "inventario_mp_app_approved_dispatches";

function config() {
  const url = process.env.SUPABASE_URL;
  // Acepta la llave secreta de servidor en cualquier formato/nombre: la
  // service_role clasica (JWT) o la nueva secret key (sb_secret_...). Ambas
  // sirven como apikey/Bearer en PostgREST y saltan RLS. NO usar la
  // publishable/anon aqui (respeta RLS y no podria insertar).
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key, ready: Boolean(url && key) };
}

const MISSING_MESSAGE =
  "Configura SUPABASE_URL y la llave secreta (SUPABASE_SECRET_KEY o SUPABASE_SERVICE_ROLE_KEY) para guardar y acumular planes aprobados.";

// GET: devuelve el acumulado de toneladas transportadas (suma de la tabla).
export async function GET() {
  const { url, key, ready } = config();
  if (!ready) {
    return NextResponse.json({ ok: false, message: MISSING_MESSAGE, totalTransportado: null });
  }

  const response = await fetch(`${url}/rest/v1/${TABLE}?select=toneladas`, {
    headers: { apikey: key!, Authorization: `Bearer ${key!}` },
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json({ ok: false, message: `Supabase ${response.status}: ${detail}`, totalTransportado: null });
  }

  const rows = (await response.json()) as Array<{ toneladas: number | string }>;
  const totalTransportado = rows.reduce((total, row) => total + (Number(row.toneladas) || 0), 0);
  return NextResponse.json({ ok: true, totalTransportado, registros: rows.length });
}

// POST: inserta los stops aprobados del plan diario.
export async function POST(request: Request) {
  const { url, key, ready } = config();
  if (!ready) {
    return NextResponse.json({ ok: false, message: MISSING_MESSAGE });
  }

  const body = await request.json();
  const stops = Array.isArray(body.stops) ? body.stops : [];
  if (stops.length === 0) {
    return NextResponse.json({ ok: false, message: "No hay despachos para aprobar." });
  }

  const response = await fetch(`${url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      apikey: key!,
      Authorization: `Bearer ${key!}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(stops)
  });

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json({ ok: false, message: `Supabase ${response.status}: ${detail}` });
  }

  const toneladas = stops.reduce((total: number, stop: { toneladas?: number | string }) => total + (Number(stop.toneladas) || 0), 0);
  return NextResponse.json({ ok: true, registros: stops.length, toneladas });
}
