-- Esquema para persistir los planes de distribucion aprobados.
-- Ejecutar en Supabase: Dashboard -> SQL Editor -> New query -> pegar -> Run.
--
-- Cada fila = un despacho (stop) aprobado del plan diario. Las columnas
-- replican lo que genera el plan (ver DistributionStop en src/lib/types.ts) mas
-- los campos editables de la orden (partida, placas, destino, toneladas).

create table if not exists approved_dispatches (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null,                 -- agrupa los stops aprobados juntos
  approved_at       timestamptz not null default now(),
  fecha             date not null default current_date,
  partida           text not null,
  destino           text not null,
  producto          text not null,
  tanque            text,
  toneladas         numeric not null default 0,
  camiones          integer not null default 0,
  viajes_por_camion integer not null default 0,
  placas            text,
  occupancy         numeric,
  acidez            numeric
);

create index if not exists approved_dispatches_plan_id_idx on approved_dispatches (plan_id);
create index if not exists approved_dispatches_fecha_idx on approved_dispatches (fecha);

-- El acumulado "Inventario transportado" = suma de toneladas:
--   select coalesce(sum(toneladas), 0) as total_transportado from approved_dispatches;
--
-- La app accede con el service_role key SOLO desde rutas server-side
-- (src/app/api/plan/route.ts); por eso no se habilita RLS para el anon key.
