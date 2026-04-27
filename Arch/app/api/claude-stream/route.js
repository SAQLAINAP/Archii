import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";

function isRealKey(key) {
  if (!key) return false;
  if (key.includes("...")) return false;
  if (key.length < 16) return false;
  return true;
}

export async function POST(request) {
  const { systemPrompt, userPrompt, maxTokens = 8000 } = await request.json();

  if (!systemPrompt || !userPrompt) {
    return Response.json({ error: "Missing prompts" }, { status: 400 });
  }

  const antKey = process.env.ANTHROPIC_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  if (isRealKey(antKey)) {
    const client = new Anthropic({ apiKey: antKey });
    const readable = new ReadableStream({
      async start(controller) {
        try {
          const stream = client.messages.stream({
            model: "claude-sonnet-4-5",
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          });
          for await (const chunk of stream) {
            if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
              controller.enqueue(new TextEncoder().encode(chunk.delta.text));
            }
          }
        } catch (e) { controller.error(e); }
        controller.close();
      },
    });
    return new Response(readable, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (isRealKey(groqKey)) {
    const client = new Groq({ apiKey: groqKey });
    const readable = new ReadableStream({
      async start(controller) {
        try {
          const stream = await client.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            max_tokens: Math.min(maxTokens, 8000),
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            stream: true,
          });
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || "";
            if (content) controller.enqueue(new TextEncoder().encode(content));
          }
        } catch (e) { controller.error(e); }
        controller.close();
      },
    });
    return new Response(readable, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  return Response.json({ error: "No valid keys for streaming" }, { status: 503 });
}
