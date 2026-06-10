import { FleetInput, InventoryRow, Recommendation, RouteCost } from "./types";

const refineryName = "DANEC SANGOLQUI";

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
    .map((row) => {
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
      const priority = logisticsScore > 78 ? "alta" : logisticsScore > 48 ? "media" : "baja";

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
