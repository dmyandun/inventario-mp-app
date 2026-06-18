import {
  DistributionPlan,
  DistributionStop,
  FleetInput,
  InventoryRow,
  Recommendation,
  RouteCost
} from "./types";

const refineryName = "DANEC SANGOLQUI";

// Genera el plan de distribucion diario: despacha desde las EXTRACTORAS y el
// PUERTO hacia la refineria priorizando SIEMPRE primero la acidez alta (calidad)
// y, a igualdad de acidez, la ocupacion mas copada (para liberar espacio). Asigna
// la flota en ese orden hasta agotar la capacidad diaria.
// enabledSources (opcional): nombres de nodos con ruta habilitada hacia la
// refineria. Si se pasa, solo esos origenes son despachables.
export function buildDistributionPlan(
  rows: InventoryRow[],
  fleet: FleetInput,
  enabledSources?: Set<string>
): DistributionPlan {
  const dailyCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;
  const tonsPerTrip = fleet.toneladasPorUnidad > 0 ? fleet.toneladasPorUnidad : 1;
  const tripsPerTruck = fleet.viajesPorDia > 0 ? fleet.viajesPorDia : 1;

  const sourceTypes = new Set(["EXTRACTORA", "PUERTO"]);
  const candidates = rows
    .filter(
      (row) =>
        sourceTypes.has(normalize(row.tipo)) &&
        row.disponible > 0 &&
        (!enabledSources || enabledSources.has(row.nombre))
    )
    .map((row) => {
      const occupancy = row.capacidad > 0 ? row.disponible / row.capacidad : 0;
      return { row, occupancy };
    })
    // Prioridad: 1) acidez alta primero, 2) ocupacion copada como desempate.
    .sort((a, b) => b.row.acidez - a.row.acidez || b.occupancy - a.occupancy);

  let remainingTons = dailyCapacity;
  let remainingTrips = fleet.unidades * tripsPerTruck;
  const stops: DistributionStop[] = [];

  for (const candidate of candidates) {
    if (remainingTons <= 0 || remainingTrips <= 0) break;

    const wanted = Math.min(candidate.row.disponible, remainingTons);
    const trips = Math.min(Math.ceil(wanted / tonsPerTrip), remainingTrips);
    if (trips <= 0) continue;

    const toneladas = Math.min(wanted, trips * tonsPerTrip);
    const camiones = Math.ceil(trips / tripsPerTruck);
    const viajesPorCamion = Math.ceil(trips / camiones);

    stops.push({
      origen: candidate.row.nombre,
      producto: candidate.row.producto,
      tanque: candidate.row.tanque,
      occupancy: candidate.occupancy,
      acidez: candidate.row.acidez,
      urgency: candidate.row.acidez,
      toneladas: Math.round(toneladas),
      camiones,
      viajesPorCamion
    });

    remainingTons -= toneladas;
    remainingTrips -= trips;
  }

  return {
    stops,
    toneladasTotales: stops.reduce((total, stop) => total + stop.toneladas, 0),
    camionesUsados: stops.reduce((total, stop) => total + stop.camiones, 0),
    viajesTotales: stops.reduce((total, stop) => total + stop.camiones * stop.viajesPorCamion, 0),
    capacidadDiaria: dailyCapacity
  };
}

// Capacidad libre por producto (suma de cap - disponible) de las filas que pasan
// el filtro. Reutilizable para refineria y puerto.
function freeCapacity(rows: InventoryRow[], keep: (row: InventoryRow) => boolean) {
  const byProduct: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    if (row.capacidad <= 0 || !keep(row)) continue;
    const free = Math.max(0, row.capacidad - row.disponible);
    byProduct[row.producto] = (byProduct[row.producto] ?? 0) + free;
    total += free;
  }
  return { total, byProduct };
}

// Capacidad libre de la refineria (DANEC) por producto. Valida que los despachos
// no excedan el espacio de la refineria.
export function getRefineryFreeCapacity(rows: InventoryRow[]) {
  return freeCapacity(rows, (row) => normalize(row.nombre) === normalize(refineryName));
}

// Capacidad libre del PUERTO por producto. Su almacenaje puede recibir transitos.
export function getPuertoFreeCapacity(rows: InventoryRow[]) {
  return freeCapacity(rows, (row) => normalize(row.tipo) === "PUERTO");
}

// Material entrante por producto: proveedores (pendienteRetiro), importaciones y
// transito (filas sin tanque). Necesita espacio donde almacenarse.
export function getIncomingByProduct(rows: InventoryRow[]) {
  const byProduct: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    if (row.tanque) continue;
    const incoming = row.transito + row.importaciones + row.pendienteRetiro;
    if (incoming <= 0) continue;
    byProduct[row.producto] = (byProduct[row.producto] ?? 0) + incoming;
    total += incoming;
  }
  return { total, byProduct };
}

// Estado de cada extractora (ocupacion y acidez) para que la IA evalue calidad y
// espacio disponible para el material entrante.
export function getExtractoraStatus(rows: InventoryRow[]) {
  return rows
    .filter((row) => normalize(row.tipo) === "EXTRACTORA")
    .map((row) => ({
      nombre: row.nombre,
      producto: row.producto,
      tanque: row.tanque,
      capacidad: row.capacidad,
      disponible: row.disponible,
      libre: Math.max(0, row.capacidad - row.disponible),
      occupancy: row.capacidad > 0 ? Number((row.disponible / row.capacidad).toFixed(3)) : 0,
      acidez: row.acidez
    }))
    .sort((a, b) => b.acidez - a.acidez || b.occupancy - a.occupancy);
}

export function getKpis(rows: InventoryRow[]) {
  const totalCapacity = sum(rows.map((row) => row.capacidad));
  const totalNetInventory = sum(rows.map((row) => row.disponible));
  const committedFuture = sum(rows.map((row) => row.transito + row.importaciones));
  // La acidez (% de acidos grasos libres) solo se mide en las extractoras; el
  // resto de tipos no reporta el dato, asi que se pondera solo sobre ellas.
  const extractoraRows = rows.filter((row) => normalize(row.tipo) === "EXTRACTORA");
  const extractoraInventory = sum(extractoraRows.map((row) => row.disponible));
  const weightedAcidity =
    extractoraInventory > 0
      ? sum(extractoraRows.map((row) => row.disponible * row.acidez)) / extractoraInventory
      : 0;

  return {
    totalCapacity,
    totalNetInventory,
    occupancy: totalCapacity > 0 ? totalNetInventory / totalCapacity : 0,
    committedFuture,
    weightedAcidity
  };
}

export function buildRecommendations(
  rows: InventoryRow[],
  routes: RouteCost[],
  fleet: FleetInput
): Recommendation[] {
  const refineryRows = rows.filter((row) => normalize(row.nombre) === normalize(refineryName));
  const refineryDemand = Math.max(
    0,
    sum(refineryRows.map((row) => row.pedido - row.retirado + row.pendienteRetiro)) -
      sum(refineryRows.map((row) => row.transito))
  );
  const dailyFleetCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;
  const targetMove = Math.min(refineryDemand || dailyFleetCapacity, dailyFleetCapacity);

  return rows
    .filter((row) => normalize(row.nombre) !== normalize(refineryName) && row.disponible > 0)
    .map((row): Recommendation => {
      const route = routes.find(
        (candidate) =>
          normalize(candidate.origen) === normalize(row.nombre) &&
          normalize(candidate.destino) === normalize(refineryName)
      );
      const routeCost = route ? route.km * route.costoPorKm : 9999;
      const acidityPenalty = Math.max(0, row.acidez - 3) * 18;
      const urgency = row.diasRetrazo * 22 + occupancyPressure(row) + row.pendienteRetiro * 0.03;
      const logisticsScore = Math.max(0, 100 - routeCost / 8 - acidityPenalty + urgency);
      const suggestedTons = Math.max(
        0,
        Math.min(row.disponible * 0.35, targetMove, row.pendienteRetiro || row.disponible * 0.2)
      );
      const priority: Recommendation["priority"] =
        logisticsScore > 78 ? "alta" : logisticsScore > 48 ? "media" : "baja";

      return {
        id: `${row.nombre}-${row.tanque}-${row.producto}`,
        priority,
        title: `${row.nombre} -> ${refineryName}`,
        detail: buildDetail(row, routeCost, suggestedTons),
        suggestedTons: Math.round(suggestedTons),
        source: row.nombre,
        product: row.producto,
        acidPenalty: Math.round(acidityPenalty),
        logisticsScore: Math.round(logisticsScore)
      };
    })
    .sort((a, b) => b.logisticsScore - a.logisticsScore);
}

function buildDetail(row: InventoryRow, routeCost: number, suggestedTons: number) {
  const cost = routeCost === 9999 ? "ruta pendiente" : `$${routeCost.toFixed(0)} por viaje base`;
  return `${row.producto} en ${row.tanque}. Acidez ${row.acidez.toFixed(
    1
  )}, inventario neto ${row.disponible.toLocaleString("es-EC")} t, costo referencial ${cost}. Movimiento sugerido ${Math.round(
    suggestedTons
  ).toLocaleString("es-EC")} t.`;
}

function occupancyPressure(row: InventoryRow) {
  if (row.capacidad <= 0) return 0;
  const occupancy = row.disponible / row.capacidad;
  if (occupancy > 0.9) return 28;
  if (occupancy > 0.75) return 14;
  if (occupancy < 0.25) return -16;
  return 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function normalize(value: string) {
  return value.trim().toUpperCase();
}
