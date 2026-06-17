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
  Sparkles,
  Truck,
  X
} from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { parseInventoryWorkbook } from "@/lib/excel";
import { buildDistributionPlan, buildRecommendations, getKpis } from "@/lib/optimizer";
import { sampleInventory, sampleRoutes } from "@/lib/sample-data";
import { DistributionPlan, FleetInput, InventoryRow } from "@/lib/types";

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
  const [priorityAi, setPriorityAi] = useState("");
  const [loadingPriorityAi, setLoadingPriorityAi] = useState(false);

  const products = useMemo(() => ["TODOS", ...Array.from(new Set(rows.map((row) => row.producto)))], [rows]);
  const productRows = product === "TODOS" ? rows : rows.filter((row) => row.producto === product);
  const currentRows = getLatestInventoryRows(productRows);
  const inventoryHistory = buildInventoryHistory(productRows);
  const locationHeatmap = buildLocationHeatmap(productRows);
  const refineryRows = currentRows.filter((row) => normalize(row.nombre) === normalize(refineryName));
  const originRows = currentRows.filter((row) => normalize(row.nombre) !== normalize(refineryName));
  const kpis = getKpis(currentRows);
  const refineryKpis = getKpis(refineryRows);
  const recommendations = buildRecommendations(currentRows, sampleRoutes, fleet);
  const distributionPlan = buildDistributionPlan(currentRows, fleet);
  const dailyFleetCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;
  const refineryTransito = sum(refineryRows.map((row) => row.transito));
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

    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: finalQuestion, context: buildAiContext() })
      });
      const data = await response.json();
      setAnswer(data.answer);
      setView("ia");
    } finally {
      setLoadingAi(false);
    }
  }

  function buildAiContext() {
    return JSON.stringify(
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
  }

  async function runPriorityAnalysis() {
    setLoadingPriorityAi(true);
    setPriorityAi("");
    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question:
            "Con base en el inventario actual, prioriza los despachos hacia la refineria DANEC SANGOLQUI. Indica prioridad, ubicacion, toneladas sugeridas, motivo y riesgo.",
          context: buildAiContext()
        })
      });
      const data = await response.json();
      setPriorityAi(data.answer ?? "");
    } catch {
      setPriorityAi("No se pudo completar el analisis de IA.");
    } finally {
      setLoadingPriorityAi(false);
    }
  }

  // Al cargar un Excel, dispara automaticamente el analisis de IA de prioridades.
  useEffect(() => {
    if (dataSource === "excel") {
      runPriorityAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

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

        {view === "refineria" ? (
          <section className="grid kpis">
            <Kpi icon={<PackageCheck size={19} />} label="Inventario neto refinería" value={`${format(refineryKpis.totalNetInventory)} t`} />
            <Kpi icon={<Gauge size={19} />} label="Ocupación de la refinería" value={`${(refineryKpis.occupancy * 100).toFixed(1)}%`} />
            <Kpi icon={<Truck size={19} />} label="Toneladas en tránsito" value={`${format(refineryTransito)} t`} />
            <Kpi icon={<AlertTriangle size={19} />} label="Acidez ponderada" value={refineryKpis.weightedAcidity.toFixed(2)} />
          </section>
        ) : (
          <section className="grid kpis">
            <Kpi icon={<PackageCheck size={19} />} label="Inventario neto" value={`${format(kpis.totalNetInventory)} t`} />
            <Kpi icon={<Gauge size={19} />} label="Ocupación nacional" value={`${(kpis.occupancy * 100).toFixed(1)}%`} />
            <Kpi icon={<AlertTriangle size={19} />} label="Acidez ponderada" value={kpis.weightedAcidity.toFixed(2)} />
            <Kpi icon={<Truck size={19} />} label="Capacidad flota diaria" value={`${format(dailyFleetCapacity)} t`} />
          </section>
        )}

        {view === "inventario" && (
          <InventoryView
            rows={currentRows}
            products={products}
            product={product}
            setProduct={setProduct}
            fleet={fleet}
            setFleet={setFleet}
            history={inventoryHistory}
            heatmap={locationHeatmap}
            dataSource={dataSource}
          />
        )}

        {view === "refineria" && (
          <RefineryView
            refineryRows={refineryRows}
            originRows={originRows}
            askAi={askAi}
          />
        )}

        {view === "rutas" && (
          <RoutesView
            plan={distributionPlan}
            fleet={fleet}
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

        {view !== "ia" && (
          <FloatingPriorities
            recommendations={recommendations}
            aiText={priorityAi}
            loading={loadingPriorityAi}
            dataSource={dataSource}
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
  history,
  heatmap,
  dataSource
}: {
  rows: InventoryRow[];
  products: string[];
  product: string;
  setProduct: (value: string) => void;
  fleet: FleetInput;
  setFleet: (value: FleetInput) => void;
  history: Array<{ date: string; stock: number; transito: number }>;
  heatmap: ReturnType<typeof buildLocationHeatmap>;
  dataSource: "demo" | "excel";
}) {
  return (
    <section className="grid content-stack">
      <InventoryHistoryChart history={history} dataSource={dataSource} />
      <LocationHeatmap heatmap={heatmap} />
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
    </section>
  );
}

function InventoryHistoryChart({
  history,
  dataSource
}: {
  history: Array<{ date: string; stock: number; transito: number }>;
  dataSource: "demo" | "excel";
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (history.length === 0) {
    return (
      <div className="card history-card">
        <div className="section-title">
          <div>
            <h3>Histórico de inventario</h3>
            <p className="section-note">Stock disponible en tanques vs. stock en tránsito por fecha.</p>
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
  const maxValue = Math.max(...history.flatMap((point) => [point.stock, point.transito]), 1);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maxValue * ratio));
  const latest = history[history.length - 1];
  const first = history[0];
  const change = latest && first ? latest.stock - first.stock : 0;
  const hoveredPoint = hoveredIndex === null ? null : history[hoveredIndex];

  const xFor = (index: number) =>
    padding.left + (history.length === 1 ? plotWidth / 2 : (index / (history.length - 1)) * plotWidth);
  const yFor = (value: number) => padding.top + plotHeight - (value / maxValue) * plotHeight;
  const lineFor = (key: "stock" | "transito") =>
    history.map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(index)} ${yFor(point[key])}`).join(" ");
  const tooltipWidth = 188;
  const tooltipHeight = 72;
  const tooltipX = hoveredIndex === null ? 0 : Math.min(width - tooltipWidth - 10, Math.max(10, xFor(hoveredIndex) - tooltipWidth / 2));
  const tooltipY =
    hoveredIndex === null
      ? 0
      : Math.max(10, Math.min(height - tooltipHeight - 10, yFor(history[hoveredIndex].stock) - tooltipHeight - 12));

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
          <path d={lineFor("stock")} className="chart-line inventory-line" />
          <path d={lineFor("transito")} className="chart-line available-line" />
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
              <circle cx={xFor(index)} cy={yFor(point.stock)} r={hoveredIndex === index ? "6" : "4"} className="inventory-dot" />
              <circle cx={xFor(index)} cy={yFor(point.transito)} r={hoveredIndex === index ? "6" : "4"} className="available-dot" />
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
              <text x={tooltipX + 12} y={tooltipY + 44}>Inventario: {format(hoveredPoint.stock)} t</text>
              <text x={tooltipX + 12} y={tooltipY + 62}>En tránsito: {format(hoveredPoint.transito)} t</text>
            </g>
          )}
        </svg>
      </div>
      <div className="legend">
        <span><i className="legend-dot inventory" />Inventario (disponible)</span>
        <span><i className="legend-dot available" />Stock en tránsito</span>
        <span>Último inventario: <strong>{latest ? `${format(latest.stock)} t` : "0 t"}</strong></span>
      </div>
    </div>
  );
}

function LocationHeatmap({ heatmap }: { heatmap: ReturnType<typeof buildLocationHeatmap> }) {
  const { dates, locations } = heatmap;

  return (
    <div className="card heatmap-card">
      <div className="section-title">
        <div>
          <h3>Ocupación por ubicación</h3>
          <p className="section-note">Solo ubicaciones con tanque · disponible ÷ capacidad, por fecha.</p>
        </div>
        <div className="heat-scale" aria-hidden="true">
          <span>0%</span>
          <i className="heat-scale-bar" />
          <span>100%</span>
        </div>
      </div>
      {dates.length === 0 || locations.length === 0 ? (
        <div className="empty-state">Carga un Excel con fechas para ver la ocupación por ubicación.</div>
      ) : (
        <div className="heatmap-wrap">
          <div
            className="heatmap-grid"
            style={{ gridTemplateColumns: `minmax(120px, 1.3fr) repeat(${dates.length}, minmax(48px, 1fr))` }}
          >
            <div className="heat-corner" />
            {dates.map((date) => (
              <div key={date} className="heat-col-label" title={longDate(date)}>
                {shortDate(date)}
              </div>
            ))}
            {locations.map((location) => (
              <Fragment key={location.nombre}>
                <div className="heat-row-label" title={location.nombre}>
                  {location.nombre}
                </div>
                {location.cells.map((cell) => (
                  <div
                    key={`${location.nombre}-${cell.date}`}
                    className={`heat-cell ${cell.occupancy === null ? "empty" : ""}`}
                    style={
                      cell.occupancy === null
                        ? undefined
                        : { background: heatColor(cell.occupancy), color: heatTextColor(cell.occupancy) }
                    }
                    title={
                      cell.occupancy === null
                        ? `${location.nombre} · ${longDate(cell.date)}: sin dato`
                        : `${location.nombre} · ${longDate(cell.date)}\nOcupación ${(cell.occupancy * 100).toFixed(1)}%\nDisponible ${format(cell.disponible)} t / Capacidad ${format(cell.capacidad)} t`
                    }
                  >
                    {cell.occupancy === null ? "–" : `${Math.round(cell.occupancy * 100)}%`}
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RefineryView({
  refineryRows,
  originRows,
  askAi
}: {
  refineryRows: InventoryRow[];
  originRows: InventoryRow[];
  askAi: (question: string) => void;
}) {
  return (
    <section className="grid content-stack">
      <div className="card">
        <div className="section-title">
          <h3>Estado de DANEC SANGOLQUI</h3>
          <button className="btn" onClick={() => askAi("Evalua riesgo de abastecimiento de refineria y prioriza acciones.")}>
            <Bot size={16} /> Evaluar
          </button>
        </div>
        <InventoryTable rows={refineryRows} />
      </div>
      <div className="card">
        <div className="section-title"><h3>Orígenes disponibles</h3></div>
        <InventoryTable rows={originRows.slice(0, 8)} compact />
      </div>
    </section>
  );
}

function RoutesView({
  plan,
  fleet,
  dailyFleetCapacity,
  askAi
}: {
  plan: DistributionPlan;
  fleet: FleetInput;
  dailyFleetCapacity: number;
  askAi: (question: string) => void;
}) {
  return (
    <section className="grid content-stack">
      <DistributionPlanCard plan={plan} fleet={fleet} askAi={askAi} />
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
    </section>
  );
}

function DistributionPlanCard({
  plan,
  fleet,
  askAi
}: {
  plan: DistributionPlan;
  fleet: FleetInput;
  askAi: (question: string) => void;
}) {
  return (
    <div className="card">
      <div className="section-title">
        <div>
          <h3>Plan de distribución diario</h3>
          <p className="section-note">
            Flota: {format(fleet.unidades)} camiones · {format(plan.capacidadDiaria)} t/día · asignadas{" "}
            {format(plan.toneladasTotales)} t en {format(plan.camionesUsados)} camiones. Prioriza ubicaciones
            copadas y de mayor acidez.
          </p>
        </div>
        <button className="btn" onClick={() => askAi("Revisa el plan de distribucion diario y sugiere ajustes por ocupacion, acidez y flota.")}>
          <Bot size={16} /> Revisar
        </button>
      </div>
      {plan.stops.length === 0 ? (
        <div className="empty-state">No hay orígenes con inventario disponible para despachar.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Origen</th>
                <th>Producto</th>
                <th>Ocupación</th>
                <th>Acidez</th>
                <th>Toneladas</th>
                <th>Camiones</th>
                <th>Viajes/camión</th>
              </tr>
            </thead>
            <tbody>
              {plan.stops.map((stop, index) => (
                <tr key={`${stop.origen}-${stop.tanque}-${stop.producto}-${index}`}>
                  <td>{stop.origen}</td>
                  <td>{stop.producto}</td>
                  <td>{(stop.occupancy * 100).toFixed(1)}%</td>
                  <td>{stop.acidez.toFixed(1)}</td>
                  <td>{format(stop.toneladas)} t</td>
                  <td>{format(stop.camiones)}</td>
                  <td>{format(stop.viajesPorCamion)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>Total</td>
                <td>{format(plan.toneladasTotales)} t</td>
                <td>{format(plan.camionesUsados)}</td>
                <td>{format(plan.viajesTotales)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
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

function FloatingPriorities({
  recommendations,
  aiText,
  loading,
  dataSource
}: {
  recommendations: ReturnType<typeof buildRecommendations>;
  aiText: string;
  loading: boolean;
  dataSource: "demo" | "excel";
}) {
  const [open, setOpen] = useState(false);
  const highCount = recommendations.filter((item) => item.priority === "alta").length;

  return (
    <div className="floating-priorities">
      {open && (
        <div className="fp-panel" role="dialog" aria-label="Prioridades sugeridas">
          <div className="fp-header">
            <div>
              <h3>Prioridades sugeridas</h3>
              <span className="fp-sub">Solo lectura · {dataSource === "excel" ? "Excel cargado" : "Datos demo"}</span>
            </div>
            <button className="fp-close" onClick={() => setOpen(false)} aria-label="Cerrar">
              <X size={18} />
            </button>
          </div>
          <div className="fp-body">
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
            <div className="fp-ai">
              <div className="fp-ai-title">
                <Sparkles size={15} /> Análisis IA
              </div>
              <div className="fp-ai-body">
                {loading
                  ? "Analizando inventario con IA..."
                  : aiText
                    ? aiText
                    : dataSource === "excel"
                      ? "Sin análisis disponible."
                      : "Carga un Excel para generar el análisis de IA automáticamente."}
              </div>
            </div>
          </div>
        </div>
      )}
      <button
        className="fp-fab"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Prioridades sugeridas"
        title="Prioridades sugeridas"
      >
        <Bot size={22} />
        {highCount > 0 && <span className="fp-badge">{highCount}</span>}
      </button>
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
  const grouped = new Map<string, { date: string; stock: number; transito: number }>();

  rows.forEach((row) => {
    const date = normalizeDate(row.fecha) || "Sin fecha";
    const current = grouped.get(date) ?? { date, stock: 0, transito: 0 };
    if (row.tanque) {
      // Stock fisico en tanque (disponible: refineria/puerto no llenan INVENTARIO).
      current.stock += row.disponible;
    } else {
      // Tipos de suministro: cada uno llena solo su columna
      // (TRANSITO->transito, IMPORTACIONES->importaciones, PROVEEDORES->pendienteRetiro).
      current.transito += row.transito + row.importaciones + row.pendienteRetiro;
    }
    grouped.set(date, current);
  });

  return Array.from(grouped.values()).sort((a, b) => comparableDate(a.date) - comparableDate(b.date));
}

function buildLocationHeatmap(rows: InventoryRow[]) {
  const dateOrder = new Map<string, number>();
  const byLocation = new Map<string, Map<string, { disponible: number; capacidad: number }>>();

  rows.forEach((row) => {
    // Solo ubicaciones con tanque fisico; los tipos de suministro no se grafican.
    if (!row.tanque) return;
    const date = normalizeDate(row.fecha) || "Sin fecha";
    dateOrder.set(date, comparableDate(date));
    const series = byLocation.get(row.nombre) ?? new Map();
    const cell = series.get(date) ?? { disponible: 0, capacidad: 0 };
    cell.disponible += row.disponible;
    cell.capacidad += row.capacidad;
    series.set(date, cell);
    byLocation.set(row.nombre, series);
  });

  const dates = Array.from(dateOrder.keys()).sort((a, b) => (dateOrder.get(a) ?? 0) - (dateOrder.get(b) ?? 0));

  const locations = Array.from(byLocation.entries())
    .map(([nombre, series]) => ({
      nombre,
      cells: dates.map((date) => {
        const cell = series.get(date);
        const occupancy = cell && cell.capacidad > 0 ? cell.disponible / cell.capacidad : null;
        return { date, occupancy, disponible: cell?.disponible ?? 0, capacidad: cell?.capacidad ?? 0 };
      })
    }))
    .sort((a, b) => {
      const aRefinery = normalize(a.nombre) === normalize(refineryName);
      const bRefinery = normalize(b.nombre) === normalize(refineryName);
      if (aRefinery !== bRefinery) return aRefinery ? -1 : 1;
      return a.nombre.localeCompare(b.nombre, "es");
    });

  return { dates, locations };
}

function heatColor(occupancy: number) {
  const t = Math.max(0, Math.min(1, occupancy));
  const stops: Array<{ p: number; c: [number, number, number] }> = [
    { p: 0, c: [240, 246, 233] },
    { p: 0.6, c: [125, 179, 91] },
    { p: 1, c: [63, 125, 69] }
  ];

  let lower = stops[0];
  let upper = stops[stops.length - 1];
  for (let index = 0; index < stops.length - 1; index += 1) {
    if (t >= stops[index].p && t <= stops[index + 1].p) {
      lower = stops[index];
      upper = stops[index + 1];
      break;
    }
  }

  const span = upper.p - lower.p || 1;
  const ratio = (t - lower.p) / span;
  const channel = (index: number) => Math.round(lower.c[index] + (upper.c[index] - lower.c[index]) * ratio);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function heatTextColor(occupancy: number) {
  return occupancy > 0.55 ? "#ffffff" : "#1f2520";
}

function getLatestInventoryRows(rows: InventoryRow[]) {
  // Cada ubicacion/entidad (nombre) se actualiza en fechas distintas: la
  // refineria llega a una fecha mas nueva que extractoras o proveedores.
  // Por eso se toma la fecha mas reciente DE CADA ubicacion y se conservan
  // TODAS sus filas de ese dia: todos los tanques de un sitio y todos los
  // lotes de un proveedor (que puede tener varios el mismo dia).
  const latestTsByName = new Map<string, number>();

  for (const row of rows) {
    const ts = rowTimestamp(row.fecha);
    const current = latestTsByName.get(row.nombre);
    if (current === undefined || ts > current) {
      latestTsByName.set(row.nombre, ts);
    }
  }

  return rows.filter((row) => rowTimestamp(row.fecha) === latestTsByName.get(row.nombre));
}

function rowTimestamp(value: string) {
  const parsed = new Date(normalizeDate(value)).getTime();
  return Number.isNaN(parsed) ? -1 : parsed;
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

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function normalize(value: string) {
  return value.trim().toUpperCase();
}
