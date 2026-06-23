import { NextResponse } from "next/server";

const defaultModels = [
  "openai/gpt-oss-20b:fastest",
  "Qwen/Qwen3-32B:fastest",
  "deepseek-ai/DeepSeek-V3-0324:fastest",
  "meta-llama/Llama-3.3-70B-Instruct:fastest"
];

export async function POST(request: Request) {
  const body = await request.json();
  const question = String(body.question ?? "");
  const context = String(body.context ?? "");

  if (!process.env.HF_TOKEN) {
    return NextResponse.json({
      answer:
        "HF_TOKEN no esta configurado. Agrega un token de Hugging Face con permiso para Inference Providers."
    });
  }

  const models = getModelChain();
  const errors: string[] = [];

  for (const model of models) {
    try {
      const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.HF_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0.2,
          // Holgado: los modelos de razonamiento gastan tokens en <think> antes de
          // la respuesta; con poco presupuesto se truncaban a mitad del razonamiento.
          max_tokens: 1600,
          messages: [
            {
              role: "system",
              content: [
                "Eres un planificador logistico de materia prima para la refineria DANEC SANGOLQUI.",
                "Responde siempre en espanol.",
                "Reglas de priorizacion del plan diario:",
                "1) El cuello de botella es la CAPACIDAD DE RECEPCION de la refineria: estaciones CONFIGURABLES (lista 'stations'); cada estacion tiene un nombre, un cupo de tanqueros/dia (tankers) y los productos que puede recibir (productos). Un producto solo se recibe en la estacion a la que esta asignado. El plan debe LLENAR esos cupos entre semana para evitar horas extra el fin de semana.",
                "2) Prioriza la materia prima de mayor acidez (top 25%) desde EXTRACTORAS y PUERTO: esos entran primero. Los cupos restantes de cada estacion se llenan por la ruta mas barata (minimo costo).",
                "3) No exceder el almacenamiento libre de la refineria por producto (refineryFreeCapacity). Los productos que no esten asignados a ninguna estacion no pueden recibirse y quedan fuera del plan.",
                "4) Usa SOLO las rutas habilitadas que vienen en routes (cada ruta es un par origen->destino activo); no sugieras movimientos por rutas que no esten en esa lista.",
                "Equilibra llenar la recepcion (productividad semanal), acidez (calidad) y costo, sin exceder el almacenamiento de la refineria.",
                "No muestres razonamiento interno, borradores, etiquetas <think> ni cadenas de pensamiento.",
                "Entrega solo conclusiones accionables para operacion.",
                "No uses Markdown, asteriscos, negritas, tablas ni encabezados decorativos.",
                "Formato: bullets de texto plano con prioridad, ubicacion, producto, toneladas sugeridas, motivo (acidez o liberar espacio) y riesgo.",
                "Usa maximo 6 bullets y cierra con una accion inmediata."
              ].join(" ")
            },
            {
              role: "user",
              content: `Contexto operativo:\n${context}\n\nPregunta:\n${question}`
            }
          ]
        })
      });

      const data = await response.json().catch(() => null);
      const answer = cleanAnswer(data?.choices?.[0]?.message?.content);

      if (response.ok && answer) {
        return NextResponse.json({ answer });
      }

      errors.push(`${model}: ${readError(data, response.status)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error desconocido";
      errors.push(`${model}: ${message}`);
    }
  }

  return NextResponse.json(
    {
      answer: `No se pudo completar la inferencia con los modelos configurados.\n\nIntentos:\n${errors.join("\n")}`
    },
    { status: 502 }
  );
}

function getModelChain() {
  const configured = [process.env.HF_MODEL, ...(process.env.HF_FALLBACK_MODELS ?? "").split(",")]
    .map((model) => model?.trim())
    .filter((model): model is string => Boolean(model));

  return Array.from(new Set([...configured, ...defaultModels]));
}

function cleanAnswer(value: unknown) {
  if (typeof value !== "string") return "";

  let text = value;

  // Modelos de razonamiento: la respuesta va DESPUES del ultimo cierre de
  // <think>/<thinking>. Si existe, quedarse solo con lo posterior.
  const closeMatch = text.match(/<\/think>|<\/thinking>/gi);
  if (closeMatch) {
    const lastClose = Math.max(text.lastIndexOf("</think>"), text.lastIndexOf("</thinking>"));
    const tag = text.lastIndexOf("</thinking>") === lastClose ? "</thinking>" : "</think>";
    text = text.slice(lastClose + tag.length);
  }

  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    // <think> sin cierre = respuesta truncada a mitad del razonamiento: descartar.
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .replace(/<\/?think(?:ing)?>/gi, "")
    .replace(/^\s*(analysis|reasoning|thought)\s*:\s*/gim, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function readError(data: unknown, status: number) {
  if (isRecord(data)) {
    const error = data.error;
    if (isRecord(error) && typeof error.message === "string") return error.message;
    if (typeof error === "string") return error;
    if (typeof data.message === "string") return data.message;
  }
  return `HTTP ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
