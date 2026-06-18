import solver from "javascript-lp-solver";
import {
  DistributionPlan,
  DistributionStop,
  FleetInput,
  InventoryRow,
  Recommendation,
  RouteCost,
  StationCapacity
} from "./types";

const refineryName = "DANEC SANGOLQUI";

// Pesos del objetivo (maximizar uso de recepcion):
const BASE = 1; // por tonelada: incentiva LLENAR la recepcion (evita horas extra fin de semana)
const URGENT_BONUS = 1000; // por tonelada de fuente en el top 25% de acidez -> se despacha primero
const ACID_W = 10; // afina el orden dentro del mismo grupo por acidez
const EPS_COST = 0.0001; // desempate: a igualdad, prefiere ruta mas barata / menos viajes

const sourceTypes = new Set(["EXTRACTORA", "PUERTO"]);

// Cupos de recepcion por defecto (tanqueros/dia por estacion).
export const DEFAULT_STATION_TANKERS: StationCapacity = { 1: 5, 2: 5, 3: 5 };

// Cada estacion recibe solo ciertos productos (por conexion de tuberia). Ruteo por
// nombre de producto en mayusculas. Productos sin estacion no pueden recibirse.
export function stationFor(producto: string): 1 | 2 | 3 | 0 {
  const p = producto.toUpperCase();
  if (/HIBRIDO|ROJO DE PALMA|ESTEARINA/.test(p)) return 1;
  if (/SOYA|CANOLA|GIRASOL|MA[IÍ]Z/.test(p)) return 2;
  if (/PKO|PALMISTE/.test(p)) return 3;
  return 0;
}

export type DistributionOptions = {
  enabledSources?: Set<string>;
  routeCost?: (origen: string, destino: string) => number;
  stationTankers?: StationCapacity;
};

type Source = {
  row: InventoryRow;
  occupancy: number;
  costPerTrip: number;
  estacion: 1 | 2 | 3;
  urgent: boolean;
};

// Plan de distribucion diario (MILP, javascript-lp-solver). El cuello de botella es
// la CAPACIDAD DE RECEPCION de la refineria: 3 estaciones, cada una recibe solo
// ciertos productos y un cupo de tanqueros/dia. El plan LLENA la recepcion (para
// explotarla entre semana) priorizando la acidez alta (top 25%) y minimizando costo,
// sin exceder el almacenamiento libre de la refineria.
export function buildDistributionPlan(
  rows: InventoryRow[],
  fleet: FleetInput,
  options: DistributionOptions = {}
): DistributionPlan {
  const { enabledSources, routeCost, stationTankers = DEFAULT_STATION_TANKERS } = options;
  const dailyCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;
  const truckCap = fleet.toneladasPorUnidad > 0 ? fleet.toneladasPorUnidad : 1;
  const tripsPerTruck = fleet.viajesPorDia > 0 ? fleet.viajesPorDia : 1;

  const candidates = rows.filter(
    (row) =>
      sourceTypes.has(normalize(row.tipo)) &&
      row.disponible > 0 &&
      (!enabledSources || enabledSources.has(row.nombre)) &&
      stationFor(row.producto) !== 0
  );

  const empty: DistributionPlan = {
    stops: [],
    toneladasTotales: 0,
    camionesUsados: 0,
    viajesTotales: 0,
    capacidadDiaria: dailyCapacity,
    costoTotal: 0
  };
  if (candidates.length === 0) return empty;

  // Acidez "urgente" = top 25% (percentil 75) de las fuentes del dia.
  const p75 = percentile(candidates.map((row) => row.acidez), 0.75);

  const sources: Source[] = candidates.map((row) => ({
    row,
    occupancy: row.capacidad > 0 ? row.disponible / row.capacidad : 0,
    costPerTrip: routeCost ? Math.max(0, routeCost(row.nombre, refineryName)) : 0,
    estacion: stationFor(row.producto) as 1 | 2 | 3,
    urgent: row.acidez >= p75
  }));

  const refineryFree = getRefineryFreeCapacity(rows).byProduct;
  const products = Array.from(new Set(sources.map((source) => source.row.producto)));

  const solved = solvePlan(sources, products, { refineryFree, truckCap, stationTankers });
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
      estacion: source.estacion,
      occupancy: source.occupancy,
      acidez: source.row.acidez,
      urgency: source.row.acidez,
      toneladas,
      camiones,
      viajesPorCamion,
      costo: Math.round(source.costPerTrip * trips)
    });
  });
  // Por estacion y luego mayor acidez para lectura.
  stops.sort((a, b) => a.estacion - b.estacion || b.acidez - a.acidez || b.toneladas - a.toneladas);

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
  truckCap: number;
  stationTankers: StationCapacity;
};

// MILP: maximiza Σ w·tons (llenar recepcion, acidez top-25% primero) menos un
// desempate de costo. Topes: disponible por fuente, almacenamiento libre por
// producto, y cupo de tanqueros por estacion (el limite real de recepcion).
function solvePlan(sources: Source[], products: string[], params: SolveParams) {
  const { refineryFree, truckCap, stationTankers } = params;
  const variables: Record<string, Record<string, number>> = {};
  const ints: Record<string, 1> = {};
  const constraints: Record<string, { min?: number; max?: number }> = {
    station_1: { max: stationTankers[1] ?? 0 },
    station_2: { max: stationTankers[2] ?? 0 },
    station_3: { max: stationTankers[3] ?? 0 }
  };

  for (const p of products) {
    constraints[`refcap_${p}`] = { max: refineryFree[p] ?? 0 };
  }

  sources.forEach((source, index) => {
    const p = source.row.producto;
    const weight = BASE + (source.urgent ? URGENT_BONUS : 0) + ACID_W * source.row.acidez;
    variables[`tons_${index}`] = {
      cost: weight,
      [`cap_${index}`]: 1,
      [`link_${index}`]: 1,
      [`refcap_${p}`]: 1
    };
    variables[`trips_${index}`] = {
      cost: -EPS_COST * source.costPerTrip,
      [`link_${index}`]: -truckCap,
      [`station_${source.estacion}`]: 1
    };
    constraints[`cap_${index}`] = { max: source.row.disponible };
    constraints[`link_${index}`] = { max: 0 };
    ints[`trips_${index}`] = 1;
  });

  const model = {
    optimize: "cost",
    opType: "max" as const,
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

// Percentil (0..1) de una lista de numeros (interpolacion lineal). 0 si vacia.
function percentile(values: number[], q: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
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
