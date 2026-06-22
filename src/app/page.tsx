"use client";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FileSpreadsheet,
  Gauge,
  LineChart,
  Mail,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Route,
  Save,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Truck,
  X
} from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseInventoryWorkbook } from "@/lib/excel";
import {
  buildDistributionPlan,
  buildRecommendations,
  defaultStationSeed,
  getExtractoraStatus,
  getIncomingByProduct,
  getKpis,
  getPuertoFreeCapacity,
  getRefineryFreeCapacity
} from "@/lib/optimizer";
import { sampleInventory, sampleRoutes } from "@/lib/sample-data";
import { DistributionPlan, FleetInput, InventoryRow, RouteCost, Station } from "@/lib/types";

type View = "inventario" | "datos" | "rutas" | "ia";

type DailyApproved = { fecha: string; camiones: number; costo: number; toneladas: number };

const refineryName = "DANEC SANGOLQUI";

export default function Home() {
  const [rows, setRows] = useState<InventoryRow[]>(sampleInventory);
  const [dataSource, setDataSource] = useState<"demo" | "excel">("demo");
  const [fleet, setFleet] = useState<FleetInput>({
    unidades: 65,
    toneladasPorUnidad: 32,
    viajesPorDia: 1
  });
  const [fleetSaveStatus, setFleetSaveStatus] = useState("");
  const [navOpen, setNavOpen] = useState(true);
  const [view, setView] = useState<View>("inventario");
  const [product, setProduct] = useState("TODOS");
  const [historyDays, setHistoryDays] = useState(30);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loadingAi, setLoadingAi] = useState(false);
  const [priorityAi, setPriorityAi] = useState("");
  const [loadingPriorityAi, setLoadingPriorityAi] = useState(false);
  // Acumulado real de toneladas transportadas (planes aprobados en Supabase).
  // null = Supabase no configurado/sin datos -> se usa el total del plan del dia.
  const [totalTransportado, setTotalTransportado] = useState<number | null>(null);
  // Histórico diario de planes aprobados (camiones y costo por fecha).
  const [dailyApproved, setDailyApproved] = useState<DailyApproved[]>([]);

  const refreshTransported = useCallback(async () => {
    try {
      const response = await fetch("/api/plan", { cache: "no-store" });
      const data = await response.json();
      setTotalTransportado(data.ok ? data.totalTransportado : null);
      setDailyApproved(data.ok && Array.isArray(data.daily) ? data.daily : []);
    } catch {
      setTotalTransportado(null);
      setDailyApproved([]);
    }
  }, []);

  useEffect(() => {
    refreshTransported();
  }, [refreshTransported]);

  // Flota: dato COMPARTIDO. Supabase es la fuente de verdad (todos ven lo mismo);
  // localStorage solo es respaldo si Supabase no responde y no pisa a Supabase.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/settings?key=fleet", { cache: "no-store" });
        const data = await response.json();
        if (!cancelled && data.ok && data.value && typeof data.value === "object") {
          setFleet((prev) => ({
            unidades: Number(data.value.unidades) || prev.unidades,
            toneladasPorUnidad: Number(data.value.toneladasPorUnidad) || prev.toneladasPorUnidad,
            viajesPorDia: Number(data.value.viajesPorDia) || prev.viajesPorDia
          }));
          return; // gana Supabase
        }
      } catch {
        // sin Supabase
      }
      if (cancelled) return;
      try {
        const saved = localStorage.getItem("inventario_mp_app_fleet");
        if (saved) {
          const parsed = JSON.parse(saved);
          setFleet((prev) => ({
            unidades: Number(parsed.unidades) || prev.unidades,
            toneladasPorUnidad: Number(parsed.toneladasPorUnidad) || prev.toneladasPorUnidad,
            viajesPorDia: Number(parsed.viajesPorDia) || prev.viajesPorDia
          }));
        }
      } catch {
        // localStorage no disponible
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveFleet = useCallback(async () => {
    setFleetSaveStatus("Guardando…");
    try {
      localStorage.setItem("inventario_mp_app_fleet", JSON.stringify(fleet));
    } catch {
      // ignore
    }
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "fleet", value: fleet })
      });
      const data = await response.json();
      const hora = new Date().toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit" });
      if (data.ok) {
        setFleetSaveStatus(`Guardado con éxito a las ${hora}.`);
      } else {
        setFleetSaveStatus("Guardado local (configura Supabase para compartir entre usuarios).");
      }
      return true;
    } catch {
      setFleetSaveStatus("Guardado local (sin conexión a Supabase).");
      return true;
    }
  }, [fleet]);

  // Matriz de rutas editable. routeOverrides guarda km/$/km/enabled por par
  // origen|||destino (sembrado del demo y luego mezclado con lo guardado en
  // Supabase). Las filas visibles se derivan de los nodos con tanque.
  const [routeOverrides, setRouteOverrides] = useState<Record<string, Partial<RouteCost>>>(() => {
    const seed: Record<string, Partial<RouteCost>> = {};
    for (const route of sampleRoutes) {
      seed[routeKey(route.origen, route.destino)] = {
        km: route.km,
        costoPorKm: route.costoPorKm,
        enabled: true
      };
    }
    return seed;
  });

  const refreshRoutes = useCallback(async () => {
    try {
      const response = await fetch("/api/routes", { cache: "no-store" });
      const data = await response.json();
      if (!data.ok || !Array.isArray(data.routes)) return;
      setRouteOverrides((prev) => {
        const next = { ...prev };
        for (const row of data.routes) {
          next[routeKey(row.origen, row.destino)] = {
            km: Number(row.km) || 0,
            costoPorKm: Number(row.costo_por_km) || 0,
            enabled: row.enabled !== false
          };
        }
        return next;
      });
    } catch {
      // Sin Supabase: la matriz funciona en memoria.
    }
  }, []);

  useEffect(() => {
    refreshRoutes();
  }, [refreshRoutes]);

  // Nodos de la matriz: ubicaciones con tanque (extractoras, puerto, refineria) y
  // los PROVEEDORES (suministro sin tanque). nombre -> tipo normalizado.
  const matrixNodes = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) {
      const tipo = normalize(row.tipo);
      if (["EXTRACTORA", "PUERTO", "REFINERIA", "PROVEEDORES"].includes(tipo) && row.nombre && !map.has(row.nombre)) {
        map.set(row.nombre, tipo);
      }
    }
    return map;
  }, [rows]);

  // Matriz de pares dirigidos origen->destino (origen != destino). Reglas por tipo:
  // - entre nodos con tanque (extractora/puerto/refineria): todas las combinaciones.
  // - PROVEEDORES: solo ENVIAN, y solo a extractoras y refineria (no a puerto ni
  //   entre proveedores); nunca son destino.
  const routes = useMemo<RouteCost[]>(() => {
    const list: RouteCost[] = [];
    const names = Array.from(matrixNodes.keys()).sort();
    for (const origen of names) {
      const origenTipo = matrixNodes.get(origen)!;
      for (const destino of names) {
        if (origen === destino) continue;
        const destinoTipo = matrixNodes.get(destino)!;
        if (destinoTipo === "PROVEEDORES") continue; // los proveedores no reciben
        if (origenTipo === "PROVEEDORES" && !["EXTRACTORA", "REFINERIA"].includes(destinoTipo)) continue;
        const override = routeOverrides[routeKey(origen, destino)];
        list.push({
          origen,
          destino,
          km: override?.km ?? 0,
          costoPorKm: override?.costoPorKm ?? 0,
          enabled: override?.enabled ?? true
        });
      }
    }
    return list;
  }, [matrixNodes, routeOverrides]);

  // Edits en memoria (el plan recalcula al vuelo). Persisten al pulsar "Guardar".
  const dirtyRoutes = useRef<Set<string>>(new Set());
  const [routesSaveStatus, setRoutesSaveStatus] = useState("");

  const updateRoute = useCallback((origen: string, destino: string, patch: Partial<RouteCost>) => {
    const key = routeKey(origen, destino);
    dirtyRoutes.current.add(key);
    setRoutesSaveStatus("Cambios sin guardar");
    setRouteOverrides((prev) => {
      const current = prev[key] ?? {};
      const merged: Partial<RouteCost> = {
        km: current.km ?? 0,
        costoPorKm: current.costoPorKm ?? 0,
        enabled: current.enabled ?? true,
        ...patch
      };
      return { ...prev, [key]: merged };
    });
  }, []);

  const saveRoutes = useCallback(async () => {
    const keys = Array.from(dirtyRoutes.current);
    if (keys.length === 0) {
      setRoutesSaveStatus("No hay cambios por guardar.");
      return true;
    }
    setRoutesSaveStatus("Guardando…");
    try {
      let failMessage = "";
      for (const key of keys) {
        const [origen, destino] = key.split("|||");
        const override = routeOverrides[key] ?? {};
        const response = await fetch("/api/routes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            origen,
            destino,
            km: override.km ?? 0,
            costo_por_km: override.costoPorKm ?? 0,
            enabled: override.enabled ?? true
          })
        });
        const data = await response.json();
        if (data.ok) {
          dirtyRoutes.current.delete(key);
        } else {
          failMessage = data.message ?? "No se pudo guardar.";
        }
      }
      if (failMessage) {
        setRoutesSaveStatus(failMessage);
        return false;
      }
      const hora = new Date().toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit" });
      setRoutesSaveStatus(`Guardado con éxito a las ${hora}.`);
      return true;
    } catch {
      setRoutesSaveStatus("Error de red al guardar.");
      return false;
    }
  }, [routeOverrides]);

  // Costo referencial (km × $/km) de una ruta habilitada; 0 si no existe/off.
  const routeCostRef = useCallback(
    (origen: string, destino: string) => {
      const override = routeOverrides[routeKey(origen, destino)];
      if (!override || override.enabled === false) return 0;
      return (override.km ?? 0) * (override.costoPorKm ?? 0);
    },
    [routeOverrides]
  );

  // Todos los productos del inventario (sin filtro), para asignarlos a estaciones.
  const allProducts = useMemo(
    () => Array.from(new Set(rows.map((row) => row.producto))).sort(),
    [rows]
  );

  // Estaciones de recepcion (cuello de botella del despacho). Configurables:
  // nombre, cupo de tanqueros/dia y productos asignados (arrastrables). Semilla
  // por keyword; se sobreescribe con lo guardado en Supabase / localStorage.
  const [stations, setStations] = useState<Station[]>(() =>
    defaultStationSeed(Array.from(new Set(sampleInventory.map((row) => row.producto))))
  );
  const dirtyStations = useRef(false);
  // True si las estaciones provienen de una fuente real (Supabase/localStorage), no de la
  // semilla demo. Evita pisar config real al purgar semillas demo en onFileChange.
  const stationsFromRemote = useRef(false);
  const [stationsSaveStatus, setStationsSaveStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Supabase primero; si no hay, localStorage; si tampoco, se queda la semilla.
      try {
        const response = await fetch("/api/stations", { cache: "no-store" });
        const data = await response.json();
        if (!cancelled && data.ok && Array.isArray(data.stations) && data.stations.length > 0) {
          stationsFromRemote.current = true;
          setStations(data.stations.map(normalizeStation));
          return;
        }
      } catch {
        // sin Supabase
      }
      if (cancelled) return;
      try {
        const saved = localStorage.getItem("inventario_mp_app_stations");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            stationsFromRemote.current = true;
            setStations(parsed.map(normalizeStation));
          }
        }
      } catch {
        // localStorage no disponible
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistStationsLocal = useCallback((next: Station[]) => {
    try {
      localStorage.setItem("inventario_mp_app_stations", JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const mutateStations = useCallback(
    (updater: (prev: Station[]) => Station[]) => {
      dirtyStations.current = true;
      setStationsSaveStatus("Cambios sin guardar");
      setStations((prev) => {
        const next = updater(prev);
        persistStationsLocal(next);
        return next;
      });
    },
    [persistStationsLocal]
  );

  const addStation = useCallback(() => {
    mutateStations((prev) => [
      ...prev,
      { id: `est-${Date.now()}`, nombre: `Estación ${prev.length + 1}`, tankers: 5, productos: [] }
    ]);
  }, [mutateStations]);

  const removeStation = useCallback(
    (id: string) => mutateStations((prev) => prev.filter((station) => station.id !== id)),
    [mutateStations]
  );

  const renameStation = useCallback(
    (id: string, nombre: string) =>
      mutateStations((prev) => prev.map((station) => (station.id === id ? { ...station, nombre } : station))),
    [mutateStations]
  );

  const updateStationTankers = useCallback(
    (id: string, tankers: number) =>
      mutateStations((prev) => prev.map((station) => (station.id === id ? { ...station, tankers } : station))),
    [mutateStations]
  );

  // Asigna un producto a una estacion (o lo deja sin asignar si stationId = null).
  // Lo quita de cualquier otra estacion (un producto va a una sola estacion).
  const assignProduct = useCallback(
    (producto: string, stationId: string | null) =>
      mutateStations((prev) =>
        prev.map((station) => ({
          ...station,
          productos:
            station.id === stationId
              ? Array.from(new Set([...station.productos, producto]))
              : station.productos.filter((item) => item !== producto)
        }))
      ),
    [mutateStations]
  );

  const saveStations = useCallback(async () => {
    setStationsSaveStatus("Guardando…");
    try {
      const response = await fetch("/api/stations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stations })
      });
      const data = await response.json();
      if (data.ok) {
        dirtyStations.current = false;
        const hora = new Date().toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit" });
        setStationsSaveStatus(`Guardado con éxito a las ${hora}.`);
        return true;
      }
      setStationsSaveStatus(data.message ?? "No se pudo guardar.");
      return false;
    } catch {
      setStationsSaveStatus("Error de red al guardar.");
      return false;
    }
  }, [stations]);

  // Origenes con ruta habilitada hacia la refineria (para el plan y la IA).
  const enabledSources = useMemo(
    () =>
      new Set(
        routes
          .filter((route) => route.enabled !== false && normalize(route.destino) === normalize(refineryName))
          .map((route) => route.origen)
      ),
    [routes]
  );

  const products = useMemo(() => ["TODOS", ...Array.from(new Set(rows.map((row) => row.producto)))], [rows]);
  const productRows = product === "TODOS" ? rows : rows.filter((row) => row.producto === product);
  const currentRows = getLatestInventoryRows(productRows);
  // Las visualizaciones temporales se limitan a una ventana fija de N dias (30/90)
  // anclada a la fecha mas reciente, para que quepan en pantalla sin scroll.
  const windowedRows = filterRecentDays(productRows, historyDays);
  const inventoryHistory = buildInventoryHistory(windowedRows);
  const locationHeatmap = buildLocationHeatmap(windowedRows);
  const refineryRows = currentRows.filter((row) => normalize(row.nombre) === normalize(refineryName));
  const kpis = getKpis(currentRows);
  const refineryKpis = getKpis(refineryRows);
  const enabledRoutes = routes.filter((route) => route.enabled !== false);
  const recommendations = buildRecommendations(currentRows, enabledRoutes, fleet);
  const distributionPlan = useMemo(
    () => buildDistributionPlan(currentRows, fleet, { enabledSources, routeCost: routeCostRef, stations }),
    [currentRows, fleet, enabledSources, routeCostRef, stations]
  );
  const dailyFleetCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;
  // Ocupacion de flota: toneladas asignadas por el plan diario vs. capacidad diaria.
  const fleetOccupancy =
    distributionPlan.capacidadDiaria > 0
      ? distributionPlan.toneladasTotales / distributionPlan.capacidadDiaria
      : 0;
  const refineryOpenDemand = Math.max(
    0,
    sum(refineryRows.map((row) => row.pedido - row.retirado + row.pendienteRetiro - row.transito))
  );

  async function onFileChange(file?: File) {
    if (!file) return;
    const parsed = await parseInventoryWorkbook(file);
    setRows(parsed);
    setDataSource("excel");

    // Reemplazo total: purgar las semillas demo para que no convivan con datos reales.
    // Rutas: descartar la semilla de sampleRoutes y repoblar solo desde Supabase.
    setRouteOverrides({});
    refreshRoutes();
    // Estaciones: si no hay config real persistida, reseembrar a partir de los productos
    // reales del Excel (en vez de los productos demo de la semilla original).
    if (!stationsFromRemote.current && !dirtyStations.current) {
      setStations(defaultStationSeed(Array.from(new Set(parsed.map((row) => row.producto)))));
    }
  }

  async function askAi(customQuestion = question) {
    const finalQuestion = customQuestion.trim();
    // Navega a IA de inmediato (el usuario ve "Analizando…" mientras responde).
    setView("ia");
    if (!finalQuestion) {
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
        // Para validar prioridad por acidez y espacio de almacenamiento:
        refineryFreeCapacity: getRefineryFreeCapacity(currentRows),
        puertoFreeCapacity: getPuertoFreeCapacity(currentRows),
        incomingByProduct: getIncomingByProduct(currentRows),
        extractoraStatus: getExtractoraStatus(currentRows),
        // Capacidad de recepcion: estaciones configurables (productos + cupo/dia).
        stations,
        distributionPlan,
        routes: enabledRoutes,
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
            "Prioriza los despachos hacia la refineria DANEC SANGOLQUI: primero las extractoras con acidez mas alta, validando que no excedan la capacidad libre de la refineria y que el material entrante (proveedores, importaciones, transito) tenga donde almacenarse; si una extractora del mismo producto esta copada y viene entrante, sugiere despacharla para liberar espacio. Indica prioridad, ubicacion, producto, toneladas sugeridas, motivo y riesgo.",
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

  return (
    <div className={`shell${navOpen ? "" : " nav-collapsed"}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">MP</div>
          <h1>Inventario Nacional</h1>
          <button
            type="button"
            className="nav-toggle"
            onClick={() => setNavOpen((value) => !value)}
            title={navOpen ? "Colapsar menú" : "Expandir menú"}
            aria-label={navOpen ? "Colapsar menú" : "Expandir menú"}
            aria-expanded={navOpen}
          >
            {navOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
        </div>
        <nav className="nav" aria-label="Principal">
          <NavButton active={view === "datos"} onClick={() => setView("datos")} icon={<SlidersHorizontal size={18} />} label="Datos maestros" />
          <NavButton active={view === "inventario"} onClick={() => setView("inventario")} icon={<Database size={18} />} label="Inventario" />
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
            {viewSubtitle(view) && <p>{viewSubtitle(view)}</p>}
          </div>
          <div className="actions">
            {view === "datos" && (
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
            )}
          </div>
        </section>

        {view === "rutas" && (
          <section className="grid kpis">
            <Kpi icon={<PackageCheck size={19} />} label="Inventario transportado" value={`${format(totalTransportado ?? distributionPlan.toneladasTotales)} t`} />
            <Kpi icon={<Gauge size={19} />} label="Ocupación flota" value={`${(fleetOccupancy * 100).toFixed(1)}%`} />
            <Kpi icon={<AlertTriangle size={19} />} label="Acidez ponderada" value={`${kpis.weightedAcidity.toFixed(2)}%`} />
            <Kpi icon={<Truck size={19} />} label="Capacidad flota diaria" value={`${format(dailyFleetCapacity)} t`} />
          </section>
        )}

        {view === "inventario" && (
          <section className="grid kpis">
            <Kpi icon={<PackageCheck size={19} />} label="Inventario neto" value={`${format(kpis.totalNetInventory)} t`} />
            <Kpi icon={<Gauge size={19} />} label="Ocupación nacional" value={`${(kpis.occupancy * 100).toFixed(1)}%`} />
            <Kpi icon={<AlertTriangle size={19} />} label="Acidez ponderada" value={`${kpis.weightedAcidity.toFixed(2)}%`} />
            <Kpi icon={<Truck size={19} />} label="Capacidad flota diaria" value={`${format(dailyFleetCapacity)} t`} />
          </section>
        )}

        {view === "inventario" && (
          <InventoryView
            rows={currentRows}
            products={products}
            product={product}
            setProduct={setProduct}
            historyDays={historyDays}
            setHistoryDays={setHistoryDays}
            history={inventoryHistory}
            heatmap={locationHeatmap}
            dataSource={dataSource}
          />
        )}

        {view === "rutas" && (
          <RoutesView
            plan={distributionPlan}
            fleet={fleet}
            routeCostRef={routeCostRef}
            dailyApproved={dailyApproved}
            askAi={askAi}
            onApproved={refreshTransported}
          />
        )}

        {view === "datos" && (
          <DatosMaestrosView
            fleet={fleet}
            setFleet={setFleet}
            saveFleet={saveFleet}
            fleetSaveStatus={fleetSaveStatus}
            routes={routes}
            updateRoute={updateRoute}
            saveRoutes={saveRoutes}
            routesSaveStatus={routesSaveStatus}
            stations={stations}
            allProducts={allProducts}
            addStation={addStation}
            removeStation={removeStation}
            renameStation={renameStation}
            updateStationTankers={updateStationTankers}
            assignProduct={assignProduct}
            saveStations={saveStations}
            stationsSaveStatus={stationsSaveStatus}
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
  historyDays,
  setHistoryDays,
  history,
  heatmap,
  dataSource
}: {
  rows: InventoryRow[];
  products: string[];
  product: string;
  setProduct: (value: string) => void;
  historyDays: number;
  setHistoryDays: (value: number) => void;
  history: ReturnType<typeof buildInventoryHistory>;
  heatmap: ReturnType<typeof buildLocationHeatmap>;
  dataSource: "demo" | "excel";
}) {
  const [tankCollapsed, setTankCollapsed] = useState(false);

  return (
    <section className="grid content-stack">
      <div className="inventory-filter">
        <span>Producto</span>
        <select value={product} onChange={(event) => setProduct(event.target.value)} aria-label="Producto">
          {products.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
        <span>Rango</span>
        <div className="range-toggle" role="group" aria-label="Rango de fechas">
          {[30, 90].map((days) => (
            <button
              key={days}
              type="button"
              className={historyDays === days ? "active" : ""}
              aria-pressed={historyDays === days}
              onClick={() => setHistoryDays(days)}
            >
              {days} días
            </button>
          ))}
        </div>
      </div>
      <InventoryHistoryChart history={history} dataSource={dataSource} />
      <LocationHeatmap heatmap={heatmap} />
      <div className="card">
        <div className="section-title">
          <button
            type="button"
            className="collapse-title"
            onClick={() => setTankCollapsed((value) => !value)}
            aria-expanded={!tankCollapsed}
          >
            {tankCollapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
            <div>
              <h3>Inventario por tanque</h3>
            </div>
          </button>
        </div>
        {!tankCollapsed && <InventoryTable rows={rows} />}
      </div>
    </section>
  );
}

function InventoryHistoryChart({
  history,
  dataSource
}: {
  history: ReturnType<typeof buildInventoryHistory>;
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
  // A alta densidad (ventana de 90 dias) los puntos por dia se vuelven una mancha:
  // se ocultan y solo se dibuja el dot del indice con hover; el detalle queda en el tooltip.
  const DENSE = 45;
  const showDots = history.length <= DENSE;
  const labelStep = Math.max(1, Math.ceil(history.length / 8));

  const xFor = (index: number) =>
    padding.left + (history.length === 1 ? plotWidth / 2 : (index / (history.length - 1)) * plotWidth);
  const yFor = (value: number) => padding.top + plotHeight - (value / maxValue) * plotHeight;
  const lineFor = (key: "stock" | "transito") =>
    history.map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(index)} ${yFor(point[key])}`).join(" ");
  const tooltipWidth = 188;
  const tooltipHeight = 90;
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
          {history.map((point, index) => {
            const isHovered = hoveredIndex === index;
            const showDot = showDots || isHovered;
            const showLabel = index % labelStep === 0 || index === history.length - 1;
            if (!showDot && !showLabel) return null;
            return (
              <g key={point.date}>
                {showDot && (
                  <>
                    <circle cx={xFor(index)} cy={yFor(point.stock)} r={isHovered ? "6" : "4"} className="inventory-dot" />
                    <circle cx={xFor(index)} cy={yFor(point.transito)} r={isHovered ? "6" : "4"} className="available-dot" />
                  </>
                )}
                {showLabel && (
                  <text x={xFor(index)} y={height - 10} textAnchor="middle">
                    {shortDate(point.date)}
                  </text>
                )}
              </g>
            );
          })}
          <rect
            x={padding.left}
            y={padding.top}
            width={plotWidth}
            height={plotHeight}
            className="chart-hit-area"
            onMouseMove={(event) => {
              const svg = event.currentTarget.ownerSVGElement;
              if (!svg) return;
              const bounds = svg.getBoundingClientRect();
              const xPx = ((event.clientX - bounds.left) / bounds.width) * width;
              const index = Math.round(((xPx - padding.left) / plotWidth) * (history.length - 1));
              setHoveredIndex(Math.max(0, Math.min(history.length - 1, index)));
            }}
          />
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
              <text x={tooltipX + 12} y={tooltipY + 80}>
                Ocupación: {hoveredPoint.capacidad > 0 ? `${((hoveredPoint.stock / hoveredPoint.capacidad) * 100).toFixed(1)}%` : "s/d"}
              </text>
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
  // A alta densidad (ventana de 90 dias) el % no cabe en la celda: solo color, el dato
  // exacto queda en el tooltip (title). Las etiquetas de fecha se muestran cada labelStep.
  const DENSE_COLS = 31;
  const showCellText = dates.length <= DENSE_COLS;
  const colLabelStep = Math.max(1, Math.ceil(dates.length / 12));

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
            style={{ gridTemplateColumns: `clamp(72px, 14%, 120px) repeat(${dates.length}, minmax(0, 1fr))` }}
          >
            <div className="heat-corner" />
            {dates.map((date, index) => (
              <div key={date} className="heat-col-label" title={longDate(date)}>
                {index % colLabelStep === 0 || index === dates.length - 1 ? shortDate(date) : ""}
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
                    {!showCellText ? "" : cell.occupancy === null ? "–" : `${Math.round(cell.occupancy * 100)}%`}
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

function RoutesView({
  plan,
  fleet,
  routeCostRef,
  dailyApproved,
  askAi,
  onApproved
}: {
  plan: DistributionPlan;
  fleet: FleetInput;
  routeCostRef: (origen: string, destino: string) => number;
  dailyApproved: DailyApproved[];
  askAi: (question: string) => void;
  onApproved: () => void;
}) {
  return (
    <section className="grid content-stack">
      <FleetCostChart daily={dailyApproved} />

      <DistributionPlanCard
        plan={plan}
        fleet={fleet}
        routeCostRef={routeCostRef}
        askAi={askAi}
        onApproved={onApproved}
      />
    </section>
  );
}

function DatosMaestrosView({
  fleet,
  setFleet,
  saveFleet,
  fleetSaveStatus,
  routes,
  updateRoute,
  saveRoutes,
  routesSaveStatus,
  stations,
  allProducts,
  addStation,
  removeStation,
  renameStation,
  updateStationTankers,
  assignProduct,
  saveStations,
  stationsSaveStatus
}: {
  fleet: FleetInput;
  setFleet: (value: FleetInput) => void;
  saveFleet: () => Promise<boolean>;
  fleetSaveStatus: string;
  routes: RouteCost[];
  updateRoute: (origen: string, destino: string, patch: Partial<RouteCost>) => void;
  saveRoutes: () => Promise<boolean>;
  routesSaveStatus: string;
  stations: Station[];
  allProducts: string[];
  addStation: () => void;
  removeStation: (id: string) => void;
  renameStation: (id: string, nombre: string) => void;
  updateStationTankers: (id: string, value: number) => void;
  assignProduct: (producto: string, stationId: string | null) => void;
  saveStations: () => Promise<boolean>;
  stationsSaveStatus: string;
}) {
  return (
    <section className="grid content-stack">
      <FleetCard fleet={fleet} setFleet={setFleet} saveFleet={saveFleet} fleetSaveStatus={fleetSaveStatus} />
      <RoutesMatrixCard
        routes={routes}
        updateRoute={updateRoute}
        saveRoutes={saveRoutes}
        routesSaveStatus={routesSaveStatus}
      />
      <StationsCard
        stations={stations}
        allProducts={allProducts}
        addStation={addStation}
        removeStation={removeStation}
        renameStation={renameStation}
        updateStationTankers={updateStationTankers}
        assignProduct={assignProduct}
        saveStations={saveStations}
        stationsSaveStatus={stationsSaveStatus}
      />
    </section>
  );
}

function FleetCard({
  fleet,
  setFleet,
  saveFleet,
  fleetSaveStatus
}: {
  fleet: FleetInput;
  setFleet: (value: FleetInput) => void;
  saveFleet: () => Promise<boolean>;
  fleetSaveStatus: string;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const dailyCapacity = fleet.unidades * fleet.toneladasPorUnidad * fleet.viajesPorDia;

  async function handleSave() {
    const ok = await saveFleet();
    if (ok) setCollapsed(true);
  }

  return (
    <div className="card">
      <div className="section-title">
        <button
          type="button"
          className="collapse-title"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
          <div>
            <h3>Flota disponible</h3>
            {!collapsed && (
              <p className="section-note">
                Número de transportes y toneladas por transporte. Capacidad diaria = transportes × toneladas ×
                viajes/día.
              </p>
            )}
          </div>
        </button>
        <div className="routes-save">
          {fleetSaveStatus && <span className="section-note">{fleetSaveStatus}</span>}
          {!collapsed && (
            <button className="btn primary" onClick={handleSave}>
              <Save size={16} /> Guardar
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="reception-grid">
          <label className="reception-item">
            <span className="reception-name">Número de transportes</span>
            <span className="reception-products">Tanqueros disponibles en la flota</span>
            <div className="reception-input">
              <input
                className="cell-input cell-input--num"
                type="number"
                min={0}
                value={fleet.unidades}
                onChange={(event) => setFleet({ ...fleet, unidades: Number(event.target.value) || 0 })}
              />
              <span className="section-note">tanqueros</span>
            </div>
          </label>
          <label className="reception-item">
            <span className="reception-name">Toneladas por transporte</span>
            <span className="reception-products">Carga de cada tanquero</span>
            <div className="reception-input">
              <input
                className="cell-input cell-input--num"
                type="number"
                min={0}
                value={fleet.toneladasPorUnidad}
                onChange={(event) => setFleet({ ...fleet, toneladasPorUnidad: Number(event.target.value) || 0 })}
              />
              <span className="section-note">t/tanquero</span>
            </div>
          </label>
          <div className="reception-item">
            <span className="reception-name">Capacidad diaria</span>
            <span className="reception-products">Transportes × toneladas × viajes</span>
            <div className="reception-input">
              <strong>{format(dailyCapacity)} t</strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RoutesMatrixCard({
  routes,
  updateRoute,
  saveRoutes,
  routesSaveStatus
}: {
  routes: RouteCost[];
  updateRoute: (origen: string, destino: string, patch: Partial<RouteCost>) => void;
  saveRoutes: () => Promise<boolean>;
  routesSaveStatus: string;
}) {
  const [collapsed, setCollapsed] = useState(true);

  async function handleSave() {
    const ok = await saveRoutes();
    if (ok) setCollapsed(true);
  }

  return (
    <div className="card">
      <div className="section-title">
        <button
          type="button"
          className="collapse-title"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
          <div>
            <h3>Matriz de rutas</h3>
            {!collapsed && (
              <p className="section-note">
                Edita km y $/km (costo ref. = km × $/km), input del plan. El check habilita o
                deshabilita cada nodo. Guarda para persistir en Supabase.
              </p>
            )}
          </div>
        </button>
        <div className="routes-save">
          {routesSaveStatus && <span className="section-note">{routesSaveStatus}</span>}
          {!collapsed && (
            <button className="btn primary" onClick={handleSave}>
              <Save size={16} /> Guardar
            </button>
          )}
        </div>
      </div>
      {!collapsed &&
        (routes.length === 0 ? (
          <div className="empty-state">Carga datos con ubicaciones de tanque para ver las rutas.</div>
        ) : (
          <div className="table-wrap">
            <table className="routes-table">
              <thead>
                <tr>
                  <th>Origen</th>
                  <th>Destino</th>
                  <th>Km</th>
                  <th>$/km</th>
                  <th>Costo ref.</th>
                  <th>Nodos</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => {
                  const enabled = route.enabled !== false;
                  return (
                    <tr key={routeKey(route.origen, route.destino)} className={enabled ? "" : "route-off"}>
                      <td>{route.origen}</td>
                      <td>{route.destino}</td>
                      <td>
                        <input
                          className="cell-input cell-input--num"
                          type="number"
                          min={0}
                          value={route.km}
                          onChange={(event) =>
                            updateRoute(route.origen, route.destino, { km: Number(event.target.value) || 0 })
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="cell-input cell-input--num"
                          type="number"
                          min={0}
                          step="0.01"
                          value={route.costoPorKm}
                          onChange={(event) =>
                            updateRoute(route.origen, route.destino, { costoPorKm: Number(event.target.value) || 0 })
                          }
                        />
                      </td>
                      <td>${format(route.km * route.costoPorKm)}</td>
                      <td>
                        <button
                          type="button"
                          className={`node-toggle ${enabled ? "on" : "off"}`}
                          onClick={() => updateRoute(route.origen, route.destino, { enabled: !enabled })}
                          title={enabled ? "Nodo habilitado" : "Nodo deshabilitado"}
                          aria-pressed={enabled}
                        >
                          {enabled ? "✓" : "✗"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

function StationsCard({
  stations,
  allProducts,
  addStation,
  removeStation,
  renameStation,
  updateStationTankers,
  assignProduct,
  saveStations,
  stationsSaveStatus
}: {
  stations: Station[];
  allProducts: string[];
  addStation: () => void;
  removeStation: (id: string) => void;
  renameStation: (id: string, nombre: string) => void;
  updateStationTankers: (id: string, value: number) => void;
  assignProduct: (producto: string, stationId: string | null) => void;
  saveStations: () => Promise<boolean>;
  stationsSaveStatus: string;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [dragProduct, setDragProduct] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const assigned = new Set(stations.flatMap((station) => station.productos));
  const unassigned = allProducts.filter((producto) => !assigned.has(producto));

  function handleDrop(stationId: string | null) {
    if (dragProduct) assignProduct(dragProduct, stationId);
    setDragProduct(null);
    setOverId(null);
  }

  async function handleSave() {
    const ok = await saveStations();
    if (ok) setCollapsed(true);
  }

  return (
    <div className="card">
      <div className="section-title">
        <button
          type="button"
          className="collapse-title"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
          <div>
            <h3>Estaciones de recepción</h3>
            {!collapsed && (
              <p className="section-note">
                Cupo de tanqueros/día por estación (cuello de botella del despacho). Arrastra los productos a cada
                estación; lo que quede en “Sin asignar” se excluye del plan. Aprovéchala entre semana para evitar horas
                extra el fin de semana.
              </p>
            )}
          </div>
        </button>
        <div className="routes-save">
          {stationsSaveStatus && <span className="section-note">{stationsSaveStatus}</span>}
          {!collapsed && (
            <>
              <button className="btn" onClick={addStation}>
                <Plus size={16} /> Agregar estación
              </button>
              <button className="btn primary" onClick={handleSave}>
                <Save size={16} /> Guardar
              </button>
            </>
          )}
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="stations-grid">
            {stations.map((station) => (
              <div
                key={station.id}
                className={`station-card${overId === station.id ? " over" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setOverId(station.id);
                }}
                onDragLeave={() => setOverId((current) => (current === station.id ? null : current))}
                onDrop={() => handleDrop(station.id)}
              >
                <div className="station-head">
                  <input
                    className="cell-input station-name"
                    value={station.nombre}
                    onChange={(event) => renameStation(station.id, event.target.value)}
                  />
                  <button
                    type="button"
                    className="station-remove"
                    onClick={() => removeStation(station.id)}
                    title="Eliminar estación"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <label className="station-tankers">
                  <input
                    className="cell-input cell-input--num"
                    type="number"
                    min={0}
                    value={station.tankers}
                    onChange={(event) => updateStationTankers(station.id, Number(event.target.value) || 0)}
                  />
                  <span className="section-note">tanqueros/día</span>
                </label>
                <div className="station-dropzone">
                  {station.productos.length === 0 ? (
                    <span className="dropzone-hint">Arrastra productos aquí</span>
                  ) : (
                    station.productos.map((producto) => (
                      <span
                        key={producto}
                        className="product-chip"
                        draggable
                        onDragStart={() => setDragProduct(producto)}
                        onDragEnd={() => setDragProduct(null)}
                      >
                        {producto}
                        <button
                          type="button"
                          className="chip-x"
                          onClick={() => assignProduct(producto, null)}
                          title="Quitar de la estación"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
          <div
            className={`station-pool${overId === "pool" ? " over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOverId("pool");
            }}
            onDragLeave={() => setOverId((current) => (current === "pool" ? null : current))}
            onDrop={() => handleDrop(null)}
          >
            <div className="pool-head">
              <strong>Sin asignar</strong>
              <span className="section-note">No entran al plan hasta asignarlos a una estación.</span>
            </div>
            <div className="pool-chips">
              {unassigned.length === 0 ? (
                <span className="dropzone-hint">Todos los productos están asignados.</span>
              ) : (
                unassigned.map((producto) => (
                  <span
                    key={producto}
                    className="product-chip"
                    draggable
                    onDragStart={() => setDragProduct(producto)}
                    onDragEnd={() => setDragProduct(null)}
                  >
                    {producto}
                  </span>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FleetCostChart({ daily }: { daily: DailyApproved[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (daily.length === 0) {
    return (
      <div className="card history-card">
        <div className="section-title">
          <div>
            <h3>Camiones y costo por día</h3>
            <p className="section-note">Histórico de planes aprobados (Supabase).</p>
          </div>
        </div>
        <div className="empty-state">Aprueba planes para ver la asignación de camiones y el costo por día.</div>
      </div>
    );
  }

  const width = 720;
  const height = 260;
  const padding = { top: 18, right: 20, bottom: 34, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxCamiones = Math.max(...daily.map((point) => point.camiones), 1);
  const maxCosto = Math.max(...daily.map((point) => point.costo), 1);
  const latest = daily[daily.length - 1];

  const xFor = (index: number) =>
    padding.left + (daily.length === 1 ? plotWidth / 2 : (index / (daily.length - 1)) * plotWidth);
  const yCamiones = (value: number) => padding.top + plotHeight - (value / maxCamiones) * plotHeight;
  const yCosto = (value: number) => padding.top + plotHeight - (value / maxCosto) * plotHeight;
  const lineFor = (accessor: (point: DailyApproved) => number, scale: (value: number) => number) =>
    daily.map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(index)} ${scale(accessor(point))}`).join(" ");

  const tooltipWidth = 190;
  const tooltipHeight = 72;
  const hoveredPoint = hoveredIndex === null ? null : daily[hoveredIndex];
  const tooltipX = hoveredIndex === null ? 0 : Math.min(width - tooltipWidth - 10, Math.max(10, xFor(hoveredIndex) - tooltipWidth / 2));
  const tooltipY =
    hoveredIndex === null ? 0 : Math.max(10, yCamiones(daily[hoveredIndex].camiones) - tooltipHeight - 12);

  return (
    <div className="card history-card">
      <div className="section-title">
        <div>
          <h3>Camiones y costo por día</h3>
          <p className="section-note">Histórico de planes aprobados (Supabase).</p>
        </div>
        <div className="legend">
          <span><i className="legend-dot inventory" />Camiones</span>
          <span><i className="legend-dot available" />Costo ($)</span>
          <span>Último: <strong>{format(latest.camiones)} cam · ${format(latest.costo)}</strong></span>
        </div>
      </div>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" className="chart-svg">
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <line
              key={ratio}
              x1={padding.left}
              x2={width - padding.right}
              y1={padding.top + plotHeight * ratio}
              y2={padding.top + plotHeight * ratio}
              className="grid-line"
            />
          ))}
          <path d={lineFor((point) => point.costo, yCosto)} className="chart-line available-line" />
          <path d={lineFor((point) => point.camiones, yCamiones)} className="chart-line inventory-line" />
          {daily.map((point, index) => (
            <g
              key={point.fecha}
              className="chart-hit-group"
              onMouseEnter={() => setHoveredIndex(index)}
              onFocus={() => setHoveredIndex(index)}
              tabIndex={0}
            >
              <rect
                x={xFor(index) - Math.max(18, plotWidth / Math.max(daily.length, 1) / 2)}
                y={padding.top}
                width={Math.max(36, plotWidth / Math.max(daily.length, 1))}
                height={plotHeight}
                className="chart-hit-area"
              />
              <circle cx={xFor(index)} cy={yCamiones(point.camiones)} r={hoveredIndex === index ? "6" : "4"} className="inventory-dot" />
              <circle cx={xFor(index)} cy={yCosto(point.costo)} r={hoveredIndex === index ? "6" : "4"} className="available-dot" />
              {(index === 0 || index === daily.length - 1 || daily.length <= 4) && (
                <text x={xFor(index)} y={height - 10} textAnchor="middle">
                  {shortDate(point.fecha)}
                </text>
              )}
            </g>
          ))}
          {hoveredIndex !== null && hoveredPoint && (
            <g className="chart-tooltip">
              <line x1={xFor(hoveredIndex)} x2={xFor(hoveredIndex)} y1={padding.top} y2={padding.top + plotHeight} className="hover-line" />
              <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx="8" />
              <text x={tooltipX + 12} y={tooltipY + 22} className="tooltip-title">{longDate(hoveredPoint.fecha)}</text>
              <text x={tooltipX + 12} y={tooltipY + 44}>Camiones: {format(hoveredPoint.camiones)}</text>
              <text x={tooltipX + 12} y={tooltipY + 62}>Costo: ${format(hoveredPoint.costo)}</text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}

type DispatchFields = {
  toneladas: string;
  partida: string;
  destino: string;
};

function stopKey(stop: DistributionPlan["stops"][number], index: number) {
  return `${stop.origen}-${stop.tanque}-${stop.producto}-${index}`;
}

function DistributionPlanCard({
  plan,
  fleet,
  routeCostRef,
  askAi,
  onApproved
}: {
  plan: DistributionPlan;
  fleet: FleetInput;
  routeCostRef: (origen: string, destino: string) => number;
  askAi: (question: string) => void;
  onApproved: () => void;
}) {
  const [edits, setEdits] = useState<Record<string, DispatchFields>>({});
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [status, setStatus] = useState("");

  function fieldsFor(stop: DistributionPlan["stops"][number], index: number): DispatchFields {
    const key = stopKey(stop, index);
    return (
      edits[key] ?? {
        toneladas: String(stop.toneladas),
        partida: stop.origen,
        destino: refineryName
      }
    );
  }

  function update(key: string, base: DispatchFields, field: keyof DispatchFields, value: string) {
    setEdits((prev) => ({ ...prev, [key]: { ...base, [field]: value } }));
  }

  // Costo estimado del despacho = costo ref. (km × $/km) de la ruta partida→destino
  // por el numero de viajes del stop.
  function costoFor(stop: DistributionPlan["stops"][number], fields: DispatchFields) {
    const viajes = stop.camiones * stop.viajesPorCamion;
    return Math.round(routeCostRef(fields.partida || stop.origen, fields.destino || refineryName) * viajes);
  }

  const orders = plan.stops.map((stop, index) => {
    const fields = fieldsFor(stop, index);
    return { stop, fields, costo: costoFor(stop, fields) };
  });

  const costoTotal = orders.reduce((total, order) => total + order.costo, 0);

  const fechaTexto = new Date().toLocaleDateString("es-EC", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  // Cuerpo del correo (mailto, texto plano). Redactado legible en cualquier fuente
  // (sin tabla ASCII que se rompe en clientes con fuente proporcional). Sin costo
  // ni estacion (la estacion es una restriccion interna del solver).
  function buildPlainText() {
    const lines = orders.map(({ stop, fields }, index) => {
      return [
        `${index + 1}. ${fields.partida || stop.origen}  ->  ${fields.destino || refineryName}`,
        `   Producto: ${stop.producto}`,
        `   Camiones: ${format(stop.camiones)}   Toneladas: ${fields.toneladas || "0"} t`
      ].join("\n");
    });
    return [
      `ORDEN DE DESPACHO - ${fechaTexto}`,
      "",
      lines.join("\n\n"),
      "",
      `Total: ${format(plan.camionesUsados)} camiones · ${format(plan.toneladasTotales)} t`
    ].join("\n");
  }

  // Abre el cliente de correo del usuario (mailto) con la orden ya redactada.
  // Sin destinatario fijo: el usuario elige a quien enviarla en su cliente.
  function openMailto() {
    const asunto = encodeURIComponent(`Orden de despacho - ${fechaTexto}`);
    const cuerpo = encodeURIComponent(buildPlainText());
    window.location.href = `mailto:?subject=${asunto}&body=${cuerpo}`;
  }

  // Aprueba el plan: guarda los despachos en Supabase y los cuenta como
  // transportados (refresca el KPI "Inventario transportado" via onApproved).
  async function approve() {
    if (orders.length === 0) return;
    setApproving(true);
    setStatus("Aprobando plan…");
    try {
      const planId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
      const fecha = new Date().toISOString().slice(0, 10);
      const stops = orders.map(({ stop, fields, costo }) => ({
        plan_id: planId,
        fecha,
        partida: fields.partida || stop.origen,
        destino: fields.destino || refineryName,
        producto: stop.producto,
        tanque: stop.tanque,
        toneladas: Number(fields.toneladas) || 0,
        camiones: stop.camiones,
        viajes_por_camion: stop.viajesPorCamion,
        costo,
        occupancy: stop.occupancy,
        acidez: stop.acidez
      }));
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stops })
      });
      const data = await response.json();
      if (data.ok) {
        setStatus(`Plan aprobado: ${format(data.toneladas)} t registradas como transportadas.`);
        setApproved(true);
        onApproved();
      } else {
        setStatus(data.message ?? "No se pudo aprobar el plan.");
      }
    } catch {
      setStatus("Error de red al aprobar el plan.");
    } finally {
      setApproving(false);
    }
  }

  const busy = approving;

  return (
    <div className="card">
      <div className="section-title">
        <div>
          <h3>Plan de distribución diario</h3>
          <p className="section-note">
            Límite = capacidad de recepción por estación. Asignados {format(plan.camionesUsados)} tanqueros (
            {format(plan.toneladasTotales)} t) · costo total ${format(plan.costoTotal)}. Prioriza acidez alta y mínimo
            costo; aprueba y abre la orden en tu correo.
          </p>
        </div>
        <button
          className="btn"
          onClick={() =>
            askAi(
              "Explica por que se propone este plan de distribucion diario. Justifica cada despacho por: acidez (los del top 25% entran primero), costo de ruta (a igualdad, la mas barata) y cupo de recepcion por estacion. Indica que llena cada estacion, por que ese origen y no otro, y senala riesgos o cuellos de botella."
            )
          }
        >
          <Bot size={16} /> Revisar con IA
        </button>
      </div>
      {plan.stops.length === 0 ? (
        <div className="empty-state">No hay orígenes con inventario disponible para despachar.</div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="dispatch-table">
              <thead>
                <tr>
                  <th>Partida</th>
                  <th>Producto</th>
                  <th>Camiones</th>
                  <th>Toneladas</th>
                  <th>Destino</th>
                  <th>Costo estimado</th>
                </tr>
              </thead>
              <tbody>
                {plan.stops.map((stop, index) => {
                  const key = stopKey(stop, index);
                  const fields = fieldsFor(stop, index);
                  return (
                    <tr key={key}>
                      <td>
                        <input
                          className="cell-input"
                          value={fields.partida}
                          onChange={(event) => update(key, fields, "partida", event.target.value)}
                        />
                      </td>
                      <td>{stop.producto}</td>
                      <td>{format(stop.camiones)}</td>
                      <td>
                        <input
                          className="cell-input cell-input--num"
                          type="number"
                          min={0}
                          value={fields.toneladas}
                          onChange={(event) => update(key, fields, "toneladas", event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          className="cell-input"
                          value={fields.destino}
                          onChange={(event) => update(key, fields, "destino", event.target.value)}
                        />
                      </td>
                      <td>${format(costoFor(stop, fields))}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Total</td>
                  <td>{format(plan.camionesUsados)}</td>
                  <td>{format(plan.toneladasTotales)} t</td>
                  <td />
                  <td>${format(costoTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="dispatch-send">
            <div className="dispatch-actions">
              <button className="btn primary" onClick={approve} disabled={busy}>
                <CheckCircle2 size={16} /> {approving ? "Aprobando…" : "Aprobar plan"}
              </button>
              {approved && (
                <button className="btn mailto-btn" onClick={openMailto} title="Abrir la orden en tu cliente de correo">
                  <Mail size={16} /> Abrir en correo
                </button>
              )}
            </div>
          </div>
          {status && <p className="section-note dispatch-status">{status}</p>}
        </>
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
  const isDemo = dataSource !== "excel";
  const aiItems = parseAiPriorities(aiText);

  return (
    <div className="floating-priorities">
      {open && (
        <div className="fp-panel" role="dialog" aria-label="Prioridades sugeridas">
          <div className="fp-header">
            <div>
              <h3>Prioridades sugeridas</h3>
              <span className="fp-sub">Solo lectura · {isDemo ? "Vista previa · datos demo" : "Excel cargado"}</span>
            </div>
            <button className="fp-close" onClick={() => setOpen(false)} aria-label="Cerrar">
              <X size={18} />
            </button>
          </div>
          <div className="fp-body">
            {isDemo && (
              <div className="fp-demo-note">
                Vista previa con datos de ejemplo. Carga el Excel en Datos maestros para ver datos reales.
              </div>
            )}
            <div className={`recommendations${isDemo ? " is-demo" : ""}`}>
              {recommendations.slice(0, 6).map((item) => (
                <article className="rec" key={item.id}>
                  <header>
                    <h4>{item.title}</h4>
                    <span className={`pill ${priorityPill(item.priority)}`}>{item.priority}</span>
                  </header>
                  <p>{item.detail}</p>
                </article>
              ))}
            </div>
            <div className="fp-ai">
              <div className="fp-ai-title">
                <Sparkles size={15} /> Análisis IA
              </div>
              {loading ? (
                <div className="fp-ai-body">Analizando inventario con IA...</div>
              ) : aiItems.length > 0 ? (
                <div className="recommendations">
                  {aiItems.map((item, index) => (
                    <article className="rec" key={`ai-${index}`}>
                      <header>
                        <h4>{item.title}</h4>
                        <span className={`pill ${priorityPill(item.priority)}`}>{item.priority}</span>
                      </header>
                      <p>{item.detail}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="fp-ai-body">
                  {aiText
                    ? aiText
                    : dataSource === "excel"
                      ? "Sin análisis disponible."
                      : "Carga un Excel para generar el análisis de IA automáticamente."}
                </div>
              )}
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
      {icon} <span className="nav-label">{label}</span>
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
  if (view === "rutas") return "Plan de distribución diario";
  if (view === "datos") return "Datos maestros";
  if (view === "ia") return "Asistente IA operativo";
  return "Inventario";
}

function viewSubtitle(view: View) {
  if (view === "rutas") return "Despacho del día por acidez, costo y capacidad de recepción, con histórico de aprobados.";
  if (view === "datos") return "Flota, matriz de rutas y estaciones de recepción que alimentan el plan.";
  if (view === "ia") return "Consultas ejecutivas con contexto de inventario, rutas, flota y calidad.";
  return "";
}

function format(value: number) {
  return Math.round(value).toLocaleString("es-EC");
}

type AiPriority = { priority: "crítica" | "alta" | "media" | "baja"; title: string; detail: string };

function normalizePriority(word: string): AiPriority["priority"] {
  const w = word.toLowerCase();
  if (w.startsWith("crit") || w.startsWith("crít")) return "crítica";
  return w as AiPriority["priority"];
}

// Convierte el texto del analisis IA en items priorizados para renderizar como
// tarjetas. Acepta el formato real del modelo, p. ej.:
//   "- Prioridad alta: PDE SHUSHUFINDI -> DANEC (ACEITE). 603 t ... Riesgo: ..."
// y tambien "alta :: titulo :: detalle". Las lineas sin prioridad se omiten.
function parseAiPriorities(text: string): AiPriority[] {
  if (!text) return [];
  const items: AiPriority[] = [];
  for (const raw of text.split(/\r?\n+/)) {
    const line = raw.replace(/^[\s\-*•▪·]+/, "").replace(/^\d+[.)]\s*/, "").trim();
    if (!line) continue;

    // Formato pedido "prioridad :: titulo :: detalle".
    if (line.includes("::")) {
      const parts = line.split("::").map((part) => part.trim());
      const pWord = parts.find((part) => /^(prioridad\s+)?(cr[ií]tica|alta|media|baja)$/i.test(part));
      const rest = parts.filter((part) => part !== pWord && part);
      if (pWord) {
        const priority = normalizePriority(pWord.replace(/prioridad\s+/i, ""));
        const title = rest[0] ?? "Sugerencia IA";
        items.push({ priority, title, detail: rest.slice(1).join(" — ") || title });
        continue;
      }
    }

    // Formato real: "Prioridad <nivel>: <titulo>. <detalle>".
    const match = line.match(/^(?:prioridad\s+)?(cr[ií]tica|alta|media|baja)\b\s*[:.\-–]?\s*/i);
    if (!match) continue;
    const priority = normalizePriority(match[1]);
    const rest = line.slice(match[0].length).trim();
    const dot = rest.search(/\.\s/); // titulo = hasta el primer punto seguido de espacio
    const title = dot > 0 ? rest.slice(0, dot).trim() : rest;
    const detail = dot > 0 ? rest.slice(dot + 1).trim() : rest;
    items.push({ priority, title: title || "Sugerencia IA", detail: detail || title });
  }
  return items;
}

function priorityPill(priority: string) {
  return priority === "alta" || priority === "crítica" ? "risk" : priority === "media" ? "warn" : "ok";
}

function buildInventoryHistory(rows: InventoryRow[]) {
  const grouped = new Map<string, { date: string; stock: number; transito: number; capacidad: number }>();

  rows.forEach((row) => {
    const date = normalizeDate(row.fecha) || "Sin fecha";
    const current = grouped.get(date) ?? { date, stock: 0, transito: 0, capacidad: 0 };
    if (row.tanque) {
      // Stock fisico en tanque (disponible: refineria/puerto no llenan INVENTARIO).
      current.stock += row.disponible;
      current.capacidad += row.capacidad;
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

function filterRecentDays(rows: InventoryRow[], days: number) {
  // Ventana de escala fija anclada a la fecha mas reciente presente en los datos
  // (no a "hoy": el demo/Excel pueden ser historicos). Inclusiva de N dias.
  if (rows.length === 0) return rows;
  const maxTs = Math.max(...rows.map((row) => rowTimestamp(row.fecha)));
  const cutoff = maxTs - (days - 1) * 86_400_000;
  return rows.filter((row) => rowTimestamp(row.fecha) >= cutoff);
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
  // La fecha canonica (YYYY-MM-DD) es el dia UTC; se formatea en UTC para no
  // retroceder un dia al renderizar en zonas horarias negativas (Ecuador UTC-5).
  return parsed.toLocaleDateString("es-EC", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function longDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("es-EC", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function normalize(value: string) {
  return value.trim().toUpperCase();
}

function routeKey(origen: string, destino: string) {
  return `${origen}|||${destino}`;
}

// Normaliza una estacion cruda (Supabase / localStorage) al tipo Station.
function normalizeStation(raw: unknown): Station {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(record.id ?? `est-${Math.random().toString(36).slice(2)}`),
    nombre: String(record.nombre ?? "Estación"),
    tankers: Number(record.tankers) || 0,
    productos: Array.isArray(record.productos) ? record.productos.map(String) : []
  };
}
