import {
  DistributionPlan,
  DistributionStop,
  FleetInput,
  InventoryRow,
  Recommendation,
  RouteCost
} from "./types";

const refineryName = "DANEC SANGOLQUI";

// Umbral de calidad: por encima de 3 de acidez la materia prima empieza a
// degradarse y el despacho se vuelve urgente.
const ACID_THRESHOLD = 3;
// La ocupacion (0..100) es el driver principal del despacho; la acidez puede
// "rescatar" tanques criticos aunque no esten copados. ACID_WEIGHT alto hace que
// cada punto de acidez sobre el umbral sume tanto como 20 puntos de ocupacion.
const OCC_WEIGHT = 1;
const ACID_WEIGHT = 20;

// Genera el plan de distribucion diario: asigna la flota a los origenes en orden
// de urgencia (ocupacion copada primero, luego acidez alta) hasta agotar la
// capacidad diaria, e informa toneladas, camiones y viajes por camion.
export function buildDistributionPlan(rows: InventoryRow[], fleet: FleetInput): DistributionPlan {
  const dailyCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;
  const tonsPerTrip = fleet.toneladasPorUnidad > 0 ? fleet.toneladasPorUnidad : 1;
  const tripsPerTruck = fleet.viajesPorDia > 0 ? fleet.viajesPorDia : 1;

  const candidates = rows
    .filter((row) => normalize(row.nombre) !== normalize(refineryName) && row.disponible > 0)
    .map((row) => {
      const occupancy = row.capacidad > 0 ? row.disponible / row.capacidad : 0;
      const acidityExcess = Math.max(0, row.acidez - ACID_THRESHOLD);
      const urgency = occupancy * 100 * OCC_WEIGHT + acidityExcess * ACID_WEIGHT;
      return { row, occupancy, urgency };
    })
    .sort((a, b) => b.urgency - a.urgency);

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
      urgency: candidate.urgency,
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

export function getKpis(rows: InventoryRow[]) {
  const totalCapacity = sum(rows.map((row) => row.capacidad));
  const totalNetInventory = sum(rows.map((row) => row.disponible));
  const committedFuture = sum(rows.map((row) => row.transito + row.importaciones));
  const weightedAcidity =
    totalNetInventory > 0
      ? sum(rows.map((row) => row.disponible * row.acidez)) / totalNetInventory
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
