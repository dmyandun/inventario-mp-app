import solver from "javascript-lp-solver";
import {
  DistributionPlan,
  DistributionStop,
  FleetInput,
  InventoryRow,
  Recommendation,
  RouteCost
} from "./types";

const refineryName = "DANEC SANGOLQUI";

// Acidez >= a este umbral es "urgente": debe despacharse por calidad.
const ACID_URGENT_THRESHOLD = 3;
// Costo base por viaje: minimiza camiones cuando los costos monetarios empatan
// (p. ej. rutas con $0). Negligible frente a costos reales (~cientos de $).
const EPS_TRIP = 1;
// Bono por acidez en el objetivo: como el total por producto es FIJO (target con
// min=max), este bono solo decide QUE fuentes cubren ese total, no cuanto. Grande
// para que la acidez alta se despache primero aunque su ruta sea mas cara.
const ACID_BONUS = 1000;

const sourceTypes = new Set(["EXTRACTORA", "PUERTO"]);

export type DistributionOptions = {
  enabledSources?: Set<string>;
  routeCost?: (origen: string, destino: string) => number;
};

type Source = {
  row: InventoryRow;
  occupancy: number;
  costPerTrip: number;
};

// Plan de distribucion diario como optimizacion de costo (MILP, javascript-lp-solver):
// minimiza el costo de transporte (costo referencial de la matriz x viajes) usando
// los MINIMOS camiones, sujeto a:
//  - acidez urgente + espacio a liberar como objetivo MINIMO por producto (restriccion),
//  - capacidad libre de la refineria por producto (tope),
//  - limite de flota (camiones x viajes/dia).
// No usa toda la flota si no hace falta.
export function buildDistributionPlan(
  rows: InventoryRow[],
  fleet: FleetInput,
  options: DistributionOptions = {}
): DistributionPlan {
  const { enabledSources, routeCost } = options;
  const dailyCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;
  const truckCap = fleet.toneladasPorUnidad > 0 ? fleet.toneladasPorUnidad : 1;
  const tripsPerTruck = fleet.viajesPorDia > 0 ? fleet.viajesPorDia : 1;
  const fleetTrips = fleet.unidades * tripsPerTruck;

  const sources: Source[] = rows
    .filter(
      (row) =>
        sourceTypes.has(normalize(row.tipo)) &&
        row.disponible > 0 &&
        (!enabledSources || enabledSources.has(row.nombre))
    )
    .map((row) => ({
      row,
      occupancy: row.capacidad > 0 ? row.disponible / row.capacidad : 0,
      costPerTrip: routeCost ? Math.max(0, routeCost(row.nombre, refineryName)) : 0
    }));

  const empty: DistributionPlan = {
    stops: [],
    toneladasTotales: 0,
    camionesUsados: 0,
    viajesTotales: 0,
    capacidadDiaria: dailyCapacity,
    costoTotal: 0
  };
  if (sources.length === 0) return empty;

  // Agregados por producto para objetivo (target) y tope (capacidad refineria).
  const refineryFree = getRefineryFreeCapacity(rows).byProduct;
  const incoming = getIncomingByProduct(rows).byProduct;
  const freeStorageSources = freeCapacity(rows, (row) => sourceTypes.has(normalize(row.tipo))).byProduct;

  const products = Array.from(new Set(sources.map((source) => source.row.producto)));
  const supplyByProduct: Record<string, number> = {};
  const urgentByProduct: Record<string, number> = {};
  for (const source of sources) {
    const p = source.row.producto;
    supplyByProduct[p] = (supplyByProduct[p] ?? 0) + source.row.disponible;
    if (source.row.acidez >= ACID_URGENT_THRESHOLD) {
      urgentByProduct[p] = (urgentByProduct[p] ?? 0) + source.row.disponible;
    }
  }

  const targetByProduct: Record<string, number> = {};
  for (const p of products) {
    const refFree = refineryFree[p] ?? 0;
    const spaceToFree = Math.max(0, (incoming[p] ?? 0) - (freeStorageSources[p] ?? 0));
    const want = (urgentByProduct[p] ?? 0) + spaceToFree;
    targetByProduct[p] = Math.min(want, refFree, supplyByProduct[p] ?? 0);
  }

  const result = solvePlan(sources, products, { refineryFree, targetByProduct, truckCap, fleetTrips, withTarget: true });
  // Si el objetivo no cabe en flota/capacidad, relajar: priorizar acidez dentro
  // de la flota disponible.
  const solved =
    result && result.feasible
      ? result
      : solvePlan(sources, products, { refineryFree, targetByProduct, truckCap, fleetTrips, withTarget: false });

  if (!solved || !solved.feasible) return empty;

  const stops: DistributionStop[] = [];
  sources.forEach((source, index) => {
    const trips = Math.round(Number(solved[`trips_${index}`] ?? 0));
    const toneladas = Math.round(Number(solved[`tons_${index}`] ?? 0));
    if (trips <= 0 || toneladas <= 0) return;
    const camiones = Math.ceil(trips / tripsPerTruck);
    const viajesPorCamion = Math.ceil(trips / camiones);
    stops.push({
      origen: source.row.nombre,
      producto: source.row.producto,
      tanque: source.row.tanque,
      occupancy: source.occupancy,
      acidez: source.row.acidez,
      urgency: source.row.acidez,
      toneladas,
      camiones,
      viajesPorCamion,
      costo: Math.round(source.costPerTrip * trips)
    });
  });
  // Mayor acidez primero para lectura.
  stops.sort((a, b) => b.acidez - a.acidez || b.toneladas - a.toneladas);

  return {
    stops,
    toneladasTotales: stops.reduce((total, stop) => total + stop.toneladas, 0),
    camionesUsados: stops.reduce((total, stop) => total + stop.camiones, 0),
    viajesTotales: stops.reduce((total, stop) => total + stop.camiones * stop.viajesPorCamion, 0),
    capacidadDiaria: dailyCapacity,
    costoTotal: stops.reduce((total, stop) => total + stop.costo, 0)
  };
}

type SolveParams = {
  refineryFree: Record<string, number>;
  targetByProduct: Record<string, number>;
  truckCap: number;
  fleetTrips: number;
  withTarget: boolean;
};

// Arma y resuelve el modelo MILP. withTarget=false relaja el objetivo minimo y en
// su lugar maximiza acidez despachada (fallback de infactibilidad).
function solvePlan(sources: Source[], products: string[], params: SolveParams) {
  const { refineryFree, targetByProduct, truckCap, fleetTrips, withTarget } = params;
  const variables: Record<string, Record<string, number>> = {};
  const ints: Record<string, 1> = {};
  const constraints: Record<string, { min?: number; max?: number }> = {
    fleet: { max: fleetTrips }
  };

  for (const p of products) {
    constraints[`refcap_${p}`] = { max: refineryFree[p] ?? 0 };
    if (withTarget && (targetByProduct[p] ?? 0) > 0) {
      // Total EXACTO por producto (min=max): no despachar de mas (minimiza
      // camiones) y dejar que el bono de acidez elija las fuentes mas acidas.
      constraints[`target_${p}`] = { min: targetByProduct[p], max: targetByProduct[p] };
    }
  }

  sources.forEach((source, index) => {
    const p = source.row.producto;
    const tonsVar: Record<string, number> = {
      [`cap_${index}`]: 1,
      [`link_${index}`]: 1,
      [`refcap_${p}`]: 1
    };
    if (constraints[`target_${p}`]) tonsVar[`target_${p}`] = 1;
    const tripsVar: Record<string, number> = {
      [`link_${index}`]: -truckCap,
      fleet: 1
    };

    if (withTarget) {
      // Minimizar costo (+ base por viaje); bono pequeno de acidez como desempate.
      tonsVar.cost = -ACID_BONUS * source.row.acidez;
      tripsVar.cost = source.costPerTrip + EPS_TRIP;
    } else {
      // Fallback: maximizar acidez despachada, penalizando costo/viajes.
      tonsVar.cost = source.row.acidez + 0.01;
      tripsVar.cost = -(source.costPerTrip * 0.0001 + EPS_TRIP * 0.0001);
    }

    variables[`tons_${index}`] = tonsVar;
    variables[`trips_${index}`] = tripsVar;
    constraints[`cap_${index}`] = { max: source.row.disponible };
    constraints[`link_${index}`] = { max: 0 };
    ints[`trips_${index}`] = 1;
  });

  const model = {
    optimize: "cost",
    opType: (withTarget ? "min" : "max") as "min" | "max",
    constraints,
    variables,
    ints
  };

  try {
    return solver.Solve(model) as unknown as { feasible: boolean; [key: string]: number | boolean };
  } catch {
    return null;
  }
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
