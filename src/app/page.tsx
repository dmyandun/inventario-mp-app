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

type View = "inventario" | "refineria" | "rutas" | "ia";

const refineryName = "DANEC SANGOLQUI";

export default function Home() {
  const [rows, setRows] = useState<InventoryRow[]>(sampleInventory);
  const [fleet, setFleet] = useState<FleetInput>({
    unidades: 12,
    toneladasPorUnidad: 28,
    viajesPorDia: 1
  });
  const [view, setView] = useState<View>("inventario");
  const [product, setProduct] = useState("TODOS");
  const [question, setQuestion] = useState("Que ubicaciones deberian priorizar despacho hacia refineria?");
  const [answer, setAnswer] = useState("");
  const [loadingAi, setLoadingAi] = useState(false);

  const products = useMemo(() => ["TODOS", ...Array.from(new Set(rows.map((row) => row.producto)))], [rows]);
  const filteredRows = product === "TODOS" ? rows : rows.filter((row) => row.producto === product);
  const refineryRows = filteredRows.filter((row) => normalize(row.nombre) === normalize(refineryName));
  const originRows = filteredRows.filter((row) => normalize(row.nombre) !== normalize(refineryName));
  const kpis = getKpis(filteredRows);
  const refineryKpis = getKpis(refineryRows);
  const recommendations = buildRecommendations(filteredRows, sampleRoutes, fleet);
  const dailyFleetCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;
  const refineryOpenDemand = Math.max(
    0,
    sum(refineryRows.map((row) => row.pedido - row.retirado + row.pendienteRetiro - row.transito))
  );

  async function onFileChange(file?: File) {
    if (!file) return;
    const parsed = await parseInventoryWorkbook(file);
    setRows(parsed);
  }

  async function askAi(customQuestion = question) {
    setLoadingAi(true);
    setQuestion(customQuestion);
    const context = JSON.stringify(
      {
        kpis,
        refineryKpis,
        refineryOpenDemand,
        dailyFleetCapacity,
        fleet,
        routes: sampleRoutes,
        topRecommendations: recommendations.slice(0, 8),
        rows: filteredRows.slice(0, 30)
      },
      null,
      2
    );

    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: customQuestion, context })
      });
      const data = await response.json();
      setAnswer(data.answer);
      setView("ia");
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
    setView("ia");
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">MP</div>
          <h1>Inventario Nacional</h1>
        </div>
        <nav className="nav" aria-label="Principal">
          <NavButton active={view === "inventario"} onClick={() => setView("inventario")} icon={<Database size={18} />} label="Inventario" />
          <NavButton active={view === "refineria"} onClick={() => setView("refineria")} icon={<Factory size={18} />} label="Refineria" />
          <NavButton active={view === "rutas"} onClick={() => setView("rutas")} icon={<Route size={18} />} label="Rutas" />
          <NavButton active={view === "ia"} onClick={() => setView("ia")} icon={<Bot size={18} />} label="IA" />
        </nav>
        <div className="sidebar-note">
          Fuente actual: archivo plano con pestaña ANEXADO. La capa de datos queda lista para reemplazarse por
          SingleStore via API server-side.
        </div>
      </aside>

      <main className="main">
        <section className="topbar">
          <div>
            <h2>{viewTitle(view)}</h2>
            <p>{viewSubtitle(view)}</p>
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
            <button className="btn primary" onClick={() => askAi()} title="Consultar IA">
              <Bot size={17} /> Analizar
            </button>
          </div>
        </section>

        <section className="grid kpis">
          <Kpi icon={<PackageCheck size={19} />} label="Inventario neto" value={`${format(kpis.totalNetInventory)} t`} />
          <Kpi icon={<Gauge size={19} />} label="Ocupación nacional" value={`${(kpis.occupancy * 100).toFixed(1)}%`} />
          <Kpi icon={<AlertTriangle size={19} />} label="Acidez ponderada" value={kpis.weightedAcidity.toFixed(2)} />
          <Kpi icon={<Truck size={19} />} label="Capacidad flota diaria" value={`${format(dailyFleetCapacity)} t`} />
        </section>

        {view === "inventario" && (
          <InventoryView
            rows={filteredRows}
            products={products}
            product={product}
            setProduct={setProduct}
            fleet={fleet}
            setFleet={setFleet}
            recommendations={recommendations}
          />
        )}

        {view === "refineria" && (
          <RefineryView
            refineryRows={refineryRows}
            originRows={originRows}
            refineryKpis={refineryKpis}
            refineryOpenDemand={refineryOpenDemand}
            dailyFleetCapacity={dailyFleetCapacity}
            recommendations={recommendations}
            askAi={askAi}
          />
        )}

        {view === "rutas" && (
          <RoutesView
            recommendations={recommendations}
            dailyFleetCapacity={dailyFleetCapacity}
            askAi={askAi}
          />
        )}

        {view === "ia" && (
          <AiView
            question={question}
            setQuestion={setQuestion}
            askAi={askAi}
            loadingAi={loadingAi}
            answer={answer}
            recommendations={recommendations}
          />
        )}
      </main>
    </div>
  );
}

function InventoryView({
  rows,
  products,
  product,
  setProduct,
  fleet,
  setFleet,
  recommendations
}: {
  rows: InventoryRow[];
  products: string[];
  product: string;
  setProduct: (value: string) => void;
  fleet: FleetInput;
  setFleet: (value: FleetInput) => void;
  recommendations: ReturnType<typeof buildRecommendations>;
}) {
  return (
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
        <InventoryTable rows={rows} />
      </div>
      <RecommendationsPanel recommendations={recommendations} />
    </section>
  );
}

function RefineryView({
  refineryRows,
  originRows,
  refineryKpis,
  refineryOpenDemand,
  dailyFleetCapacity,
  recommendations,
  askAi
}: {
  refineryRows: InventoryRow[];
  originRows: InventoryRow[];
  refineryKpis: ReturnType<typeof getKpis>;
  refineryOpenDemand: number;
  dailyFleetCapacity: number;
  recommendations: ReturnType<typeof buildRecommendations>;
  askAi: (question: string) => void;
}) {
  const coverageDays = dailyFleetCapacity > 0 ? refineryKpis.totalNetInventory / dailyFleetCapacity : 0;
  return (
    <section className="grid content-grid">
      <div className="card">
        <div className="section-title">
          <h3>Estado de DANEC SANGOLQUI</h3>
          <button className="btn" onClick={() => askAi("Evalua riesgo de abastecimiento de refineria y prioriza acciones.")}> 
            <Bot size={16} /> Evaluar
          </button>
        </div>
        <div className="mini-grid">
          <Kpi icon={<Factory size={18} />} label="Inventario refineria" value={`${format(refineryKpis.totalNetInventory)} t`} />
          <Kpi icon={<AlertTriangle size={18} />} label="Demanda abierta" value={`${format(refineryOpenDemand)} t`} />
          <Kpi icon={<Gauge size={18} />} label="Cobertura estimada" value={`${coverageDays.toFixed(1)} dias`} />
        </div>
        <InventoryTable rows={refineryRows} />
      </div>
      <div className="grid">
        <div className="card">
          <div className="section-title"><h3>Orígenes disponibles</h3></div>
          <InventoryTable rows={originRows.slice(0, 8)} compact />
        </div>
        <RecommendationsPanel recommendations={recommendations.slice(0, 4)} />
      </div>
    </section>
  );
}

function RoutesView({
  recommendations,
  dailyFleetCapacity,
  askAi
}: {
  recommendations: ReturnType<typeof buildRecommendations>;
  dailyFleetCapacity: number;
  askAi: (question: string) => void;
}) {
  return (
    <section className="grid content-grid">
      <div className="card">
        <div className="section-title">
          <h3>Matriz de rutas</h3>
          <button className="btn" onClick={() => askAi("Optimiza las rutas considerando costo por km, acidez y capacidad diaria de flota.")}> 
            <Bot size={16} /> Optimizar
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Origen</th>
                <th>Destino</th>
                <th>Km</th>
                <th>$/km</th>
                <th>Costo ref.</th>
                <th>Capacidad diaria</th>
              </tr>
            </thead>
            <tbody>
              {sampleRoutes.map((route) => (
                <tr key={`${route.origen}-${route.destino}`}>
                  <td>{route.origen}</td>
                  <td>{route.destino}</td>
                  <td>{format(route.km)}</td>
                  <td>{route.costoPorKm.toFixed(2)}</td>
                  <td>${format(route.km * route.costoPorKm)}</td>
                  <td>{format(dailyFleetCapacity)} t</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <RecommendationsPanel recommendations={recommendations} />
    </section>
  );
}

function AiView({
  question,
  setQuestion,
  askAi,
  loadingAi,
  answer,
  recommendations
}: {
  question: string;
  setQuestion: (value: string) => void;
  askAi: (question?: string) => void;
  loadingAi: boolean;
  answer: string;
  recommendations: ReturnType<typeof buildRecommendations>;
}) {
  const prompts = [
    "Que despachos debo priorizar hoy hacia refineria?",
    "Que riesgo tengo por acidez alta y como mitigarlo?",
    "Que rutas conviene usar si la flota es limitada?"
  ];
  return (
    <section className="grid content-grid">
      <div className="card ai-box">
        <div className="section-title"><h3>Asistente IA operativo</h3></div>
        <div className="filters">
          {prompts.map((prompt) => (
            <button className="btn" key={prompt} onClick={() => askAi(prompt)}>{prompt}</button>
          ))}
        </div>
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} />
        <button className="btn primary" onClick={() => askAi(question)} disabled={loadingAi}>
          <Bot size={17} /> {loadingAi ? "Analizando" : "Consultar"}
        </button>
        <div className="answer">{answer || "La respuesta aparecerá aquí."}</div>
      </div>
      <RecommendationsPanel recommendations={recommendations.slice(0, 5)} />
    </section>
  );
}

function InventoryTable({ rows, compact = false }: { rows: InventoryRow[]; compact?: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Ubicación</th>
            <th>Producto</th>
            {!compact && <th>Tanque</th>}
            <th>Capacidad</th>
            <th>Inv. neto</th>
            <th>Acidez</th>
            <th>Pendiente</th>
            <th>Tránsito</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.nombre}-${row.tanque}-${row.producto}`}>
              <td>{row.tipo}</td>
              <td>{row.nombre}</td>
              <td>{row.producto}</td>
              {!compact && <td>{row.tanque}</td>}
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
  );
}

function RecommendationsPanel({ recommendations }: { recommendations: ReturnType<typeof buildRecommendations> }) {
  return (
    <div className="card">
      <div className="section-title"><h3>Prioridades sugeridas</h3></div>
      <div className="recommendations">
        {recommendations.slice(0, 6).map((item) => (
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
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button className={active ? "active" : ""} onClick={onClick} title={label}>
      {icon} {label}
    </button>
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

function viewTitle(view: View) {
  if (view === "refineria") return "Refinería y continuidad de flujo";
  if (view === "rutas") return "Rutas, costo y capacidad logística";
  if (view === "ia") return "Asistente IA operativo";
  return "Gestión de almacenamiento y flujo a refinería";
}

function viewSubtitle(view: View) {
  if (view === "refineria") return "Demanda abierta, cobertura, inventario neto y acciones para DANEC SANGOLQUI.";
  if (view === "rutas") return "Priorización por $/km, toneladas sugeridas, acidez y flota disponible.";
  if (view === "ia") return "Consultas ejecutivas con contexto de inventario, rutas, flota y calidad.";
  return "Inventario neto, acidez, capacidad comprometida, prioridades de despacho y alertas.";
}

function format(value: number) {
  return Math.round(value).toLocaleString("es-EC");
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function normalize(value: string) {
  return value.trim().toUpperCase();
}
