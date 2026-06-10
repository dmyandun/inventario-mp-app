import * as XLSX from "xlsx";
import { InventoryRow } from "./types";

const sheetName = "ANEXADO";

export async function parseInventoryWorkbook(file: File): Promise<InventoryRow[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    throw new Error(`No se encontro la pestaña ${sheetName}.`);
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return rawRows.map(mapRow).filter((row) => row.nombre && row.producto && row.tanque);
}

function mapRow(row: Record<string, unknown>): InventoryRow {
  return {
    fecha: text(row.FECHA),
    tipo: text(row.TIPO),
    nombre: text(row.NOMBRE),
    producto: text(row.PRODUCTO),
    tanque: text(row.TANQUE),
    capacidad: num(row.CAPACIDAD),
    inventario: num(row.INVENTARIO),
    disponible: num(row.DISPONIBLE),
    acidez: num(row.ACIDEZ),
    oc: text(row.OC),
    ordenRecibidaEnBodega: text(row["ORDEN RECIBIDA EN BODEGA"]),
    fechaOrden: text(row["FECHA ORDEN"]),
    diasRetrazo: num(row["DIAS RETRAZO"]),
    pedido: num(row.PEDIDO),
    retirado: num(row.RETIRADO),
    pendienteRetiro: num(row["PENDIENTE RETIRO"]),
    observacion: text(row["OBSERVACIÓN"] ?? row.OBSERVACION),
    transito: num(row.TRANSITO),
    importaciones: num(row.IMPORTACIONES)
  };
}

function text(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").trim();
}

function num(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}
