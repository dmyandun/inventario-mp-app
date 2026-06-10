export type InventoryRow = {
  fecha: string;
  tipo: string;
  nombre: string;
  producto: string;
  tanque: string;
  capacidad: number;
  inventario: number;
  disponible: number;
  acidez: number;
  oc?: string;
  ordenRecibidaEnBodega?: string;
  fechaOrden?: string;
  diasRetrazo: number;
  pedido: number;
  retirado: number;
  pendienteRetiro: number;
  observacion?: string;
  transito: number;
  importaciones: number;
};

export type FleetInput = {
  unidades: number;
  toneladasPorUnidad: number;
  viajesPorDia: number;
};

export type RouteCost = {
  origen: string;
  destino: string;
  km: number;
  costoPorKm: number;
};

export type Recommendation = {
  id: string;
  priority: "alta" | "media" | "baja";
  title: string;
  detail: string;
  suggestedTons: number;
  source: string;
  product: string;
  acidPenalty: number;
  logisticsScore: number;
};
