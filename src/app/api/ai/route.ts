import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();
  const question = String(body.question ?? "");
  const context = String(body.context ?? "");

  if (!process.env.HF_TOKEN) {
    return NextResponse.json({
      answer:
        "HF_TOKEN no esta configurado. Cuando se agregue en Vercel, este endpoint enviara el contexto operativo a Hugging Face desde el servidor."
    });
  }

  const model = process.env.HF_MODEL ?? "mistralai/Mistral-7B-Instruct-v0.3";
  const prompt = [
    "Eres un planificador logistico de materia prima para refineria.",
    "Responde en espanol, con prioridades, riesgos y recomendaciones accionables.",
    `Contexto operativo:\n${context}`,
    `Pregunta:\n${question}`
  ].join("\n\n");

  const response = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HF_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: {
        max_new_tokens: 450,
        temperature: 0.25,
        return_full_text: false
      }
    })
  });

  if (!response.ok) {
    return NextResponse.json(
      { answer: "No se pudo completar la inferencia con Hugging Face." },
      { status: response.status }
    );
  }

  const data = await response.json();
  const answer = Array.isArray(data) ? data[0]?.generated_text : data.generated_text;
  return NextResponse.json({ answer: answer ?? "Sin respuesta del modelo." });
}
