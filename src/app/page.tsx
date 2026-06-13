"use client";

import {
  AlertTriangle,
  Bot,
  Database,
  Factory,
  FileSpreadsheet,
  Gauge,
  LineChart,
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
  const [dataSource, setDataSource] = useState<"demo" | "excel">("demo");
  const [fleet, setFleet] = useState<FleetInput>({
    unidades: 12,
    toneladasPorUnidad: 28,
    viajesPorDia: 1
  });
  const [view, setView] = useState<View>("inventario");
  const [product, setProduct] = useState("TODOS");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loadingAi, setLoadingAi] = useState(false);

  const products = useMemo(() => ["TODOS", ...Array.from(new Set(rows.map((row) => row.producto)))], [rows]);
  const productRows = product === "TODOS" ? rows : rows.filter((row) => row.producto === product);
  const currentRows = getLatestInventoryRows(productRows);
  const inventoryHistory = buildInventoryHistory(productRows);
  const refineryRows = currentRows.filter((row) => normalize(row.nombre) === normalize(refineryName));
  const originRows = currentRows.filter((row) => normalize(row.nombre) !== normalize(refineryName));
  const kpis = getKpis(currentRows);
  const refineryKpis = getKpis(refineryRows);
  const recommendations = buildRecommendations(currentRows, sampleRoutes, fleet);
  const dailyFleetCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;
  const refineryOpenDemand = Math.max(
    0,
    sum(refineryRows.map((row) => row.pedido - row.retirado + row.pendienteRetiro - row.transito))
  );

  async function onFileChange(file?: File) {
    if (!file) return;
    const parsed = await parseInventoryWorkbook(file);
    setRows(parsed);
    setDataSource("excel");
  }

  async function askAi(customQuestion = question) {
    const finalQuestion = customQuestion.trim();
    if (!finalQuestion) {
      setView("ia");
      return;
    }

    setLoadingAi(true);
    setQuestion(finalQuestion);
    setAnswer("");
    const context = JSON.stringify(
      {
        kpis,
        refineryKpis,
        refineryOpenDemand,
        dailyFleetCapacity,
        fleet,
        routes: sampleRoutes,
        topRecommendations: recommendations.slice(0, 8),
        inventoryHistory,
        rows: currentRows.slice(0, 30)
      },
      null,
      2
    );

    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: finalQuestion, context })
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
            <button className="btn primary" onClick={() => setView("ia")} title="Abrir IA">
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
            rows={currentRows}
            products={products}
            product={product}
            setProduct={setProduct}
            fleet={fleet}
            setFleet={setFleet}
            recommendations={recommendations}
            history={inventoryHistory}
            dataSource={dataSource}
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
  recommendations,
  history,
  dataSource
}: {
  rows: InventoryRow[];
  products: string[];
  product: string;
  setProduct: (value: string) => void;
  fleet: FleetInput;
  setFleet: (value: FleetInput) => void;
  recommendations: ReturnType<typeof buildRecommendations>;
  history: Array<{ date: string; disponible: number; inventario: number; capacidad: number }>;
  dataSource: "demo" | "excel";
}) {
  return (
    <section className="grid content-grid">
      <div className="grid">
        <InventoryHistoryChart history={history} dataSource={dataSource} />
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
      </div>
      <RecommendationsPanel recommendations={recommendations} />
    </section>
  );
}

function InventoryHistoryChart({
  history,
  dataSource
}: {
  history: Array<{ date: string; disponible: number; inventario: number; capacidad: number }>;
  dataSource: "demo" | "excel";
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (history.length === 0) {
    return (
      <div className="card history-card">
        <div className="section-title">
          <div>
            <h3>Histórico de inventario</h3>
            <p className="section-note">Totales por fecha del inventario filtrado.</p>
          </div>
        </div>
        <div className="empty-state">Carga un Excel con fechas para ver la evolución del inventario.</div>
      </div>
    );
  }

  const width = 720;
  const height = 260;
  const padding = { top: 18, right: 20, bottom: 34, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...history.flatMap((point) => [point.disponible, point.inventario, point.capacidad]), 1);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maxValue * ratio));
  const latest = history[history.length - 1];
  const first = history[0];
  const change = latest && first ? latest.disponible - first.disponible : 0;
  const hoveredPoint = hoveredIndex === null ? null : history[hoveredIndex];

  const xFor = (index: number) =>
    padding.left + (history.length === 1 ? plotWidth / 2 : (index / (history.length - 1)) * plotWidth);
  const yFor = (value: number) => padding.top + plotHeight - (value / maxValue) * plotHeight;
  const lineFor = (key: "disponible" | "inventario") =>
    history.map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(index)} ${yFor(point[key])}`).join(" ");
  const tooltipWidth = 188;
  const tooltipHeight = 104;
  const tooltipX = hoveredIndex === null ? 0 : Math.min(width - tooltipWidth - 10, Math.max(10, xFor(hoveredIndex) - tooltipWidth / 2));
  const tooltipY =
    hoveredIndex === null
      ? 0
      : Math.max(10, Math.min(height - tooltipHeight - 10, yFor(history[hoveredIndex].disponible) - tooltipHeight - 12));

  return (
    <div className="card history-card">
      <div className="section-title">
        <div>
          <h3>Histórico de inventario</h3>
          <p className="section-note">Totales por fecha del inventario filtrado.</p>
        </div>
        <div className="history-actions">
          <span className={`source-badge ${dataSource === "excel" ? "live" : ""}`}>
            {dataSource === "excel" ? "Excel cargado" : "Datos demo"}
          </span>
          <div className={`trend ${change < 0 ? "down" : "up"}`}>
            <LineChart size={16} />
            {change === 0 ? "Sin variación" : `${change > 0 ? "+" : ""}${format(change)} t`}
          </div>
        </div>
      </div>
      <div className="chart-wrap" aria-label="Grafico historico de inventario" onMouseLeave={() => setHoveredIndex(null)}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img">
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={padding.left} x2={width - padding.right} y1={yFor(tick)} y2={yFor(tick)} className="gridline" />
              <text x={padding.left - 10} y={yFor(tick) + 4} textAnchor="end">
                {format(tick)}
              </text>
            </g>
          ))}
          <path d={lineFor("inventario")} className="chart-line inventory-line" />
          <path d={lineFor("disponible")} className="chart-line available-line" />
          {history.map((point, index) => (
            <g
              key={point.date}
              className="chart-hit-group"
              onMouseEnter={() => setHoveredIndex(index)}
              onFocus={() => setHoveredIndex(index)}
              tabIndex={0}
            >
              <rect
                x={xFor(index) - Math.max(18, plotWidth / Math.max(history.length, 1) / 2)}
                y={padding.top}
                width={Math.max(36, plotWidth / Math.max(history.length, 1))}
                height={plotHeight}
                className="chart-hit-area"
              />
              <circle cx={xFor(index)} cy={yFor(point.inventario)} r={hoveredIndex === index ? "6" : "4"} className="inventory-dot" />
              <circle cx={xFor(index)} cy={yFor(point.disponible)} r={hoveredIndex === index ? "6" : "4"} className="available-dot" />
              {(index === 0 || index === history.length - 1 || history.length <= 4) && (
                <text x={xFor(index)} y={height - 10} textAnchor="middle">
                  {shortDate(point.date)}
                </text>
              )}
            </g>
          ))}
          {hoveredIndex !== null && hoveredPoint && (
            <g className="chart-tooltip">
              <line
                x1={xFor(hoveredIndex)}
                x2={xFor(hoveredIndex)}
                y1={padding.top}
                y2={padding.top + plotHeight}
                className="hover-line"
              />
              <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx="8" />
              <text x={tooltipX + 12} y={tooltipY + 22} className="tooltip-title">
                {longDate(hoveredPoint.date)}
              </text>
              <text x={tooltipX + 12} y={tooltipY + 44}>Disponible: {format(hoveredPoint.disponible)} t</text>
              <text x={tooltipX + 12} y={tooltipY + 62}>Inventario: {format(hoveredPoint.inventario)} t</text>
              <text x={tooltipX + 12} y={tooltipY + 80}>Capacidad: {format(hoveredPoint.capacidad)} t</text>
              <text x={tooltipX + 12} y={tooltipY + 98}>Ocupación: {occupancyRate(hoveredPoint).toFixed(1)}%</text>
            </g>
          )}
        </svg>
      </div>
      <div className="legend">
        <span><i className="legend-dot available" />Disponible</span>
        <span><i className="legend-dot inventory" />Inventario bruto</span>
        <span>Último disponible: <strong>{latest ? `${format(latest.disponible)} t` : "0 t"}</strong></span>
      </div>
    </div>
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
            <button className="btn" key={prompt} onClick={() => setQuestion(prompt)}>{prompt}</button>
          ))}
        </div>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Escribe una consulta operativa para la IA"
        />
        <button className="btn primary" onClick={() => askAi(question)} disabled={loadingAi || !question.trim()}>
          <Bot size={17} /> {loadingAi ? "Analizando" : "Consultar con IA"}
        </button>
        <div className="answer">{loadingAi ? "Analizando datos operativos..." : answer}</div>
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
            <tr key={`${row.fecha}-${row.nombre}-${row.tanque}-${row.producto}`}>
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

function buildInventoryHistory(rows: InventoryRow[]) {
  const grouped = new Map<string, { date: string; disponible: number; inventario: number; capacidad: number }>();

  rows.forEach((row) => {
    const date = normalizeDate(row.fecha) || "Sin fecha";
    const current = grouped.get(date) ?? { date, disponible: 0, inventario: 0, capacidad: 0 };
    current.disponible += row.disponible;
    current.inventario += row.inventario;
    current.capacidad += row.capacidad;
    grouped.set(date, current);
  });

  return Array.from(grouped.values()).sort((a, b) => comparableDate(a.date) - comparableDate(b.date));
}

function getLatestInventoryRows(rows: InventoryRow[]) {
  const latestDate = rows.reduce((latest, row) => {
    const current = comparableDate(normalizeDate(row.fecha));
    return current > latest ? current : latest;
  }, 0);

  if (!latestDate) return rows;

  return rows.filter((row) => comparableDate(normalizeDate(row.fecha)) === latestDate);
}

function normalizeDate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return trimmed;
}

function comparableDate(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function shortDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("es-EC", { day: "2-digit", month: "short" });
}

function longDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("es-EC", { day: "2-digit", month: "long", year: "numeric" });
}

function occupancyRate(point: { disponible: number; capacidad: number }) {
  return point.capacidad > 0 ? (point.disponible / point.capacidad) * 100 : 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function normalize(value: string) {
  return value.trim().toUpperCase();
}
