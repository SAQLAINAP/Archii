// ─── Land Advisor Chat — Gemini 2.5 Flash with Google Search grounding ────────
// Multi-turn streaming endpoint. Uses Google Search so answers reflect current
// municipal regulations, fees, and portal URLs.

const SYSTEM_PROMPT = `You are ArchiAI Land Advisor — a knowledgeable, friendly assistant helping Indian land buyers and homeowners navigate every step from land purchase to completed construction.

You specialise in:
1. **Post-purchase legal checklist** — sale deed registration, encumbrance certificate (EC), mutation/khata transfer, land-use conversion (agricultural→residential), title verification
2. **Building approval process** — city-specific authority (BBMP, BDA, GHMC, CMDA, PMC, PCMC, MCD, BMC, etc.), building plan approval, commencement certificate, completion certificate, occupancy certificate
3. **Key professionals to hire** — licensed architect, structural engineer, soil-test laboratory, geotechnical consultant, site supervisor, contractor empanelment
4. **Cost & timeline estimates** — approval fees, FSI/FAR calculations, typical timelines per city
5. **Construction sequence** — site preparation → foundation → superstructure → finishing
6. **Vastu & regulatory compliance** — setback rules, height limits, parking norms, green-building ratings
7. **Common pitfalls** — encroachments, pending dues, court attachments, B-khata vs A-khata

STRICT RULES:
- If the user hasn't mentioned their **city or district**, always ask before giving approval-process or fee details — rules differ dramatically between cities.
- When asked about fees, timelines, or portals, use your web-search capability to confirm current information (these change frequently).
- Keep answers **actionable**: use numbered steps, bullet points. No vague advice.
- Always mention the **relevant government portal** (e.g., BBMP's OBMMS, GHMC's DPMS, MahaRERA, RERA state portals).
- If a question is outside your scope (e.g., interior design prices), redirect politely.
- Respond in the **same language** as the user (English, Hindi, Kannada, Telugu, Tamil hints are fine).`;

function isRealKey(k) { return k && !k.includes("...") && k.length > 16; }

// Gemini 2.5 Flash with Google Search grounding — best for real-time regulatory info
async function streamGeminiSearch(messages) {
  const key = process.env.GEMINI_API_KEY;
  if (!isRealKey(key)) return null;
  try {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      tools: [{ googleSearch: {} }],
      systemInstruction: SYSTEM_PROMPT,
    });

    // Build history (all but last message) + latest user turn
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));
    const latest = messages[messages.length - 1].content;

    const chat   = model.startChat({ history });
    const result = await chat.sendMessageStream(latest);

    const enc = new TextEncoder();
    return new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) controller.enqueue(enc.encode(text));
          }
        } catch (e) {
          console.error("[LandAdvisor/Gemini-Search]", e.message);
          controller.error(e);
        } finally {
          controller.close();
        }
      },
    });
  } catch (e) {
    console.warn("[LandAdvisor] Gemini Search failed, will try fallback:", e.message);
    return null;
  }
}

// Gemini 2.5 Flash without search (fallback)
async function streamGeminiFallback(messages) {
  const key = process.env.GEMINI_API_KEY;
  if (!isRealKey(key)) return null;
  try {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: SYSTEM_PROMPT,
    });
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));
    const latest = messages[messages.length - 1].content;
    const chat   = model.startChat({ history });
    const result = await chat.sendMessageStream(latest);

    const enc = new TextEncoder();
    return new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) controller.enqueue(enc.encode(text));
          }
        } finally {
          controller.close();
        }
      },
    });
  } catch (e) {
    console.warn("[LandAdvisor] Gemini fallback failed:", e.message);
    return null;
  }
}

// Groq Llama — fast last-resort fallback
async function streamGroqFallback(messages) {
  const key = process.env.GROQ_API_KEY;
  if (!isRealKey(key)) return null;
  try {
    const Groq = (await import("groq-sdk")).default;
    const groq = new Groq({ apiKey: key });
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
      max_tokens: 1200,
      stream: true,
    });

    const enc = new TextEncoder();
    return new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of completion) {
            const text = chunk.choices[0]?.delta?.content || "";
            if (text) controller.enqueue(enc.encode(text));
          }
        } finally {
          controller.close();
        }
      },
    });
  } catch (e) {
    console.warn("[LandAdvisor] Groq fallback failed:", e.message);
    return null;
  }
}

export async function POST(request) {
  const { messages } = await request.json();
  if (!messages?.length) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  // Try providers in order: Gemini+Search → Gemini → Groq
  const stream =
    (await streamGeminiSearch(messages)) ||
    (await streamGeminiFallback(messages)) ||
    (await streamGroqFallback(messages));

  if (!stream) {
    return Response.json({ error: "No AI provider available" }, { status: 503 });
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
