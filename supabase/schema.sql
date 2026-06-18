-- Esquema para persistir los planes de distribucion aprobados.
-- Ejecutar en Supabase: Dashboard -> SQL Editor -> New query -> pegar -> Run.
--
-- Cada fila = un despacho (stop) aprobado del plan diario. Las columnas
-- replican lo que genera el plan (ver DistributionStop en src/lib/types.ts) mas
-- los campos editables de la orden (partida, placas, destino, toneladas).

-- Las tablas usan el prefijo del nombre de la app (inventario_mp_app_) para
-- distinguirlas de otros proyectos en la misma base de Supabase.

create table if not exists inventario_mp_app_approved_dispatches (
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
  costo             numeric not null default 0,
  occupancy         numeric,
  acidez            numeric
);

-- Para tablas ya creadas antes de agregar el costo estimado:
alter table inventario_mp_app_approved_dispatches add column if not exists costo numeric not null default 0;

create index if not exists inventario_mp_app_approved_dispatches_plan_id_idx
  on inventario_mp_app_approved_dispatches (plan_id);
create index if not exists inventario_mp_app_approved_dispatches_fecha_idx
  on inventario_mp_app_approved_dispatches (fecha);

-- Activa RLS: sin politicas, la llave publishable/anon queda sin acceso (deny
-- por defecto). La app entra solo desde el servidor con la llave secreta
-- (service_role / sb_secret_...), que SALTA RLS, asi que no se necesitan
-- politicas y la tabla queda bloqueada para clientes publicos.
alter table inventario_mp_app_approved_dispatches enable row level security;

-- El acumulado "Inventario transportado" = suma de toneladas:
--   select coalesce(sum(toneladas), 0) as total_transportado from inventario_mp_app_approved_dispatches;
--
-- La app accede SOLO desde rutas server-side (src/app/api/plan/route.ts) con la
-- llave secreta de servidor: service_role clasica (JWT) o la nueva secret key
-- (sb_secret_...). Ambas saltan RLS. La publishable/anon NO sirve para insertar.


-- ============================================================================
-- Matriz de rutas editable: km, $/km y on/off por par origen->destino.
-- Una fila por combinacion origen->destino entre nodos con tanque.
-- ============================================================================

create table if not exists inventario_mp_app_routes (
  id           uuid primary key default gen_random_uuid(),
  origen       text not null,
  destino      text not null,
  km           numeric not null default 0,
  costo_por_km numeric not null default 0,
  enabled      boolean not null default true,
  updated_at   timestamptz not null default now(),
  unique (origen, destino)
);

-- Misma postura de seguridad: RLS sin politicas; acceso solo server-side con la
-- llave secreta (src/app/api/routes/route.ts).
alter table inventario_mp_app_routes enable row level security;
