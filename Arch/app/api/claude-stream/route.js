import Anthropic from "@anthropic-ai/sdk";
import Groq      from "groq-sdk";
import OpenAI    from "openai";

// Guard: treat placeholder values like missing keys
function isRealKey(key) {
  if (!key) return false;
  if (key.includes("...")) return false;
  if (key.length < 16) return false;
  return true;
}

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(str) { return Math.ceil((str || "").length / 4); }

function truncateToTokens(str, maxTokens) {
  const maxChars = maxTokens * 4;
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + "\n...[truncated]";
}

function streamResponse(readable) {
  return new Response(readable, { 
    headers: { 
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    } 
  });
}

// ─── Provider Streamers ──────────────────────────────────────────────────────

async function streamAnthropic(systemPrompt, userPrompt, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!isRealKey(key)) return null;
  const client = new Anthropic({ apiKey: key });
  
  // Create a stream that we can return if the initial request succeeds
  const stream = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    stream: true,
  });

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
            controller.enqueue(new TextEncoder().encode(chunk.delta.text));
          }
        }
      } catch (e) {
        console.error("[Anthropic Stream] Error during streaming:", e.message);
        controller.error(e);
      } finally {
        controller.close();
      }
    },
  });
}

async function streamGemini(systemPrompt, userPrompt, maxTokens) {
  const key = process.env.GEMINI_API_KEY;
  if (!isRealKey(key)) return null;
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  // Initial request to see if provider is up
  const result = await model.generateContentStream(`${systemPrompt}\n\n${userPrompt}`);
  
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) controller.enqueue(new TextEncoder().encode(text));
        }
      } catch (e) {
        console.error("[Gemini Stream] Error during streaming:", e.message);
        controller.error(e);
      } finally {
        controller.close();
      }
    },
  });
}

async function streamGroq(systemPrompt, userPrompt, maxTokens) {
  const key = process.env.GROQ_API_KEY;
  if (!isRealKey(key)) return null;
  
  // Groq free tier: 12,000 TPM total. Reserve 4000 for output -> 8000 for input.
  const inputBudget = 8000;
  const sys = truncateToTokens(systemPrompt, Math.floor(inputBudget * 0.6));
  const usr = truncateToTokens(userPrompt,   Math.floor(inputBudget * 0.4));

  const client = new Groq({ apiKey: key });
  const stream = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: Math.min(maxTokens, 4000),
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    stream: true,
  });

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) controller.enqueue(new TextEncoder().encode(content));
        }
      } catch (e) {
        console.error("[Groq Stream] Error during streaming:", e.message);
        controller.error(e);
      } finally {
        controller.close();
      }
    },
  });
}

async function streamNvidia(systemPrompt, userPrompt, maxTokens) {
  const key = process.env.NVIDIA_NIM_API_KEY;
  if (!isRealKey(key)) return null;
  const client = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1" });
  
  const stream = await client.chat.completions.create({
    model: "meta/llama-3.1-405b-instruct",
    max_tokens: Math.min(maxTokens, 4096),
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    stream: true,
  });

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) controller.enqueue(new TextEncoder().encode(content));
        }
      } catch (e) {
        console.error("[NVIDIA Stream] Error during streaming:", e.message);
        controller.error(e);
      } finally {
        controller.close();
      }
    },
  });
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

const PROVIDERS = [
  { name: "Anthropic", fn: streamAnthropic },
  { name: "Gemini",    fn: streamGemini },
  { name: "Groq",      fn: streamGroq },
  { name: "NVIDIA",    fn: streamNvidia },
];

export async function POST(request) {
  const { systemPrompt, userPrompt, maxTokens = 8000 } = await request.json();

  if (!systemPrompt || !userPrompt) {
    return Response.json({ error: "Missing prompts" }, { status: 400 });
  }

  const errors = [];

  for (const { name, fn } of PROVIDERS) {
    try {
      console.log(`[Stream Pipeline] Trying ${name}...`);
      const readable = await fn(systemPrompt, userPrompt, maxTokens);
      if (readable) {
        console.log(`[Stream Pipeline] ✓ ${name} connected`);
        return streamResponse(readable);
      }
    } catch (e) {
      const status = e.status || e.response?.status || 500;
      console.error(`[Stream Pipeline] ✗ ${name} failed (${status}):`, e.message);
      errors.push(`${name}: ${e.message}`);
      
      // If it's a 401/403 (unauthorized), we definitely want to skip to next
      // If it's a 503/429 (overload), we definitely want to skip
      // In all cases, try next provider
    }
  }

  return Response.json({ 
    error: "All streaming providers failed or unconfigured.",
    details: errors 
  }, { status: 503 });
}
