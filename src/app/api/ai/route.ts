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
                "Eres un planificador logistico de materia prima para refineria.",
                "Responde siempre en espanol.",
                "No muestres razonamiento interno, borradores, etiquetas <think> ni cadenas de pensamiento.",
                "Entrega solo conclusiones accionables para operacion.",
                "Formato: respuesta breve con prioridad, ubicacion, toneladas sugeridas, motivo y riesgo.",
                "Usa maximo 5 bullets y cierra con una accion inmediata."
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
        return NextResponse.json({ answer: `Modelo usado: ${model}\n\n${answer}` });
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
