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
          max_tokens: 520,
          messages: [
            {
              role: "system",
              content: [
                "Eres un planificador logistico de materia prima para la refineria DANEC SANGOLQUI.",
                "Responde siempre en espanol.",
                "Reglas de priorizacion del plan diario:",
                "1) Prioriza SIEMPRE primero despachar desde las EXTRACTORAS la materia prima con acidez mas alta hacia la refineria (la acidez alta degrada la calidad y es urgente).",
                "2) Valida que esos despachos por acidez no excedan la capacidad libre de la refineria: usa refineryFreeCapacity (total y por producto). Si el producto no tiene espacio en refineria, advierte el cuello de botella.",
                "3) Valida que el material entrante (incomingByProduct: proveedores, importaciones y transito) tenga donde almacenarse. Si una extractora del mismo producto esta copada (occupancy alto / libre bajo en extractoraStatus) y viene material entrante, sugiere despachar esa extractora hacia la refineria para LIBERAR espacio y que el entrante pueda almacenarse, aunque su acidez no sea la mas alta.",
                "Equilibra calidad (acidez) y espacio (liberar extractoras copadas para el entrante) sin exceder la capacidad de la refineria.",
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

  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
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
