"use client";

import {
  AlertTriangle,
  Bot,
  Database,
  Factory,
  FileSpreadsheet,
  Gauge,
  PackageCheck,
  Route,
  Send,
  Truck
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { parseInventoryWorkbook } from "@/lib/excel";
import { buildRecommendations, getKpis } from "@/lib/optimizer";
import { sampleInventory, sampleRoutes } from "@/lib/sample-data";
import { FleetInput, InventoryRow } from "@/lib/types";

export default function Home() {
  const [rows, setRows] = useState<InventoryRow[]>(sampleInventory);
  const [fleet, setFleet] = useState<FleetInput>({
    unidades: 12,
    toneladasPorUnidad: 28,
    viajesPorDia: 1
  });
  const [product, setProduct] = useState("TODOS");
  const [question, setQuestion] = useState("Que ubicaciones deberian priorizar despacho hacia refineria?");
  const [answer, setAnswer] = useState("");
  const [loadingAi, setLoadingAi] = useState(false);

  const products = useMemo(() => ["TODOS", ...Array.from(new Set(rows.map((row) => row.producto)))], [rows]);
  const filteredRows = product === "TODOS" ? rows : rows.filter((row) => row.producto === product);
  const kpis = getKpis(filteredRows);
  const recommendations = buildRecommendations(filteredRows, sampleRoutes, fleet);

  async function onFileChange(file?: File) {
    if (!file) return;
    const parsed = await parseInventoryWorkbook(file);
    setRows(parsed);
  }

  async function askAi() {
    setLoadingAi(true);
    const context = JSON.stringify(
      {
        kpis,
        fleet,
        topRecommendations: recommendations.slice(0, 5),
        rows: filteredRows.slice(0, 20)
      },
      null,
      2
    );

    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, context })
      });
      const data = await response.json();
      setAnswer(data.answer);
    } finally {
      setLoadingAi(false);
    }
  }

  async function notifyTelegram() {
    const top = recommendations[0];
    const message = top
      ? `Prioridad inventario MP: ${top.title}. ${top.detail}`
      : "No hay recomendaciones activas.";
    const response = await fetch("/api/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message })
    });
    const data = await response.json();
    setAnswer(data.ok ? "Notificacion enviada a Telegram." : data.message);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">MP</div>
          <h1>Inventario Nacional</h1>
        </div>
        <nav className="nav" aria-label="Principal">
          <button className="active" title="Inventario">
            <Database size={18} /> Inventario
          </button>
          <button title="Refineria">
            <Factory size={18} /> Refineria
          </button>
          <button title="Rutas">
            <Route size={18} /> Rutas
          </button>
          <button title="IA">
            <Bot size={18} /> IA
          </button>
        </nav>
        <div className="sidebar-note">
          Fuente actual: archivo plano con pestaña ANEXADO. La capa de datos queda lista para reemplazarse por
          SingleStore via API server-side.
        </div>
      </aside>

      <main className="main">
        <section className="topbar">
          <div>
            <h2>Gestión de almacenamiento y flujo a refinería</h2>
            <p>Inventario neto, acidez, capacidad comprometida, prioridades de despacho y alertas.</p>
          </div>
          <div className="actions">
            <label className="btn" title="Cargar Excel ANEXADO">
              <FileSpreadsheet size={17} />
              Cargar Excel
              <input
                hidden
                type="file"
                accept=".xlsx,.xls"
                onChange={(event) => onFileChange(event.target.files?.[0])}
              />
            </label>
            <button className="btn" onClick={notifyTelegram} title="Enviar alerta">
              <Send size={17} /> Telegram
            </button>
            <button className="btn primary" onClick={askAi} title="Consultar IA">
              <Bot size={17} /> Analizar
            </button>
          </div>
        </section>

        <section className="grid kpis">
          <Kpi icon={<PackageCheck size={19} />} label="Inventario neto" value={`${format(kpis.totalNetInventory)} t`} />
          <Kpi icon={<Gauge size={19} />} label="Ocupación nacional" value={`${(kpis.occupancy * 100).toFixed(1)}%`} />
          <Kpi icon={<AlertTriangle size={19} />} label="Acidez ponderada" value={kpis.weightedAcidity.toFixed(2)} />
          <Kpi icon={<Truck size={19} />} label="Comprometido futuro" value={`${format(kpis.committedFuture)} t`} />
        </section>

        <section className="grid content-grid">
          <div className="card">
            <div className="section-title">
              <h3>Inventario por tanque</h3>
              <div className="filters">
                <select value={product} onChange={(event) => setProduct(event.target.value)} aria-label="Producto">
                  {products.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  value={fleet.unidades}
                  onChange={(event) => setFleet({ ...fleet, unidades: Number(event.target.value) })}
                  aria-label="Unidades de flota"
                  title="Unidades de flota"
                />
                <input
                  type="number"
                  min="0"
                  value={fleet.toneladasPorUnidad}
                  onChange={(event) => setFleet({ ...fleet, toneladasPorUnidad: Number(event.target.value) })}
                  aria-label="Toneladas por unidad"
                  title="Toneladas por unidad"
                />
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Ubicación</th>
                    <th>Producto</th>
                    <th>Tanque</th>
                    <th>Capacidad</th>
                    <th>Inv. neto</th>
                    <th>Acidez</th>
                    <th>Pendiente</th>
                    <th>Tránsito</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={`${row.nombre}-${row.tanque}-${row.producto}`}>
                      <td>{row.tipo}</td>
                      <td>{row.nombre}</td>
                      <td>{row.producto}</td>
                      <td>{row.tanque}</td>
                      <td>{format(row.capacidad)}</td>
                      <td>{format(row.disponible)}</td>
                      <td>
                        <span className={`pill ${row.acidez > 4 ? "risk" : row.acidez > 3 ? "warn" : "ok"}`}>
                          {row.acidez.toFixed(1)}
                        </span>
                      </td>
                      <td>{format(row.pendienteRetiro)}</td>
                      <td>{format(row.transito + row.importaciones)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid">
            <div className="card">
              <div className="section-title">
                <h3>Prioridades sugeridas</h3>
              </div>
              <div className="recommendations">
                {recommendations.slice(0, 5).map((item) => (
                  <article className="rec" key={item.id}>
                    <header>
                      <h4>{item.title}</h4>
                      <span className={`pill ${item.priority === "alta" ? "risk" : item.priority === "media" ? "warn" : "ok"}`}>
                        {item.priority}
                      </span>
                    </header>
                    <p>{item.detail}</p>
                  </article>
                ))}
              </div>
            </div>

            <div className="card ai-box">
              <div className="section-title">
                <h3>Asistente IA</h3>
              </div>
              <textarea value={question} onChange={(event) => setQuestion(event.target.value)} />
              <button className="btn primary" onClick={askAi} disabled={loadingAi}>
                <Bot size={17} /> {loadingAi ? "Analizando" : "Consultar"}
              </button>
              <div className="answer">{answer || "La respuesta aparecerá aquí."}</div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="card kpi">
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}

function format(value: number) {
  return Math.round(value).toLocaleString("es-EC");
}
