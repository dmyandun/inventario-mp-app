import { NextResponse } from "next/server";

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

  const model = process.env.HF_MODEL ?? "openai/gpt-oss-20b:fastest";

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
        temperature: 0.25,
        max_tokens: 450,
        messages: [
          {
            role: "system",
            content:
              "Eres un planificador logistico de materia prima para refineria. Responde en espanol, con prioridades, riesgos y recomendaciones accionables."
          },
          {
            role: "user",
            content: `Contexto operativo:\n${context}\n\nPregunta:\n${question}`
          }
        ]
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return NextResponse.json(
        {
          answer:
            data?.error?.message ??
            data?.error ??
            "No se pudo completar la inferencia con Hugging Face Router."
        },
        { status: response.status }
      );
    }

    const answer = data?.choices?.[0]?.message?.content;
    return NextResponse.json({ answer: answer ?? "Sin respuesta del modelo." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json(
      { answer: `No se pudo conectar con Hugging Face Router: ${message}` },
      { status: 502 }
    );
  }
}
