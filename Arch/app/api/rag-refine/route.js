// ─── LangGraph Refinement Loop ───────────────────────────────────────────────
// Uses a stateful graph to iteratively improve a floor plan until score ≥ 75.
// Max 2 refinement iterations to control cost.
//
// POST body:
//   params:      { plotW, plotH, bhk, facing, city, budget, belief, floors }
//   layout:      computed layout from layoutEngine
//   vastuReport: current vastu report (with score + violations)
//   ragContext:  formatted RAG context string

import Anthropic from "@anthropic-ai/sdk";
import { computeLayout } from "../../../lib/layoutEngine.js";
import { scoreVastuLayout } from "../../../lib/vastuRules.js";
import { buildFloorPlanSVGPromptWithRAG } from "../../../lib/prompts.js";
import { retrieveRAGContext, buildRefinementHint } from "../../../lib/rag/retriever.js";

const MAX_ITERATIONS = 2;
const SCORE_TARGET   = 75;

// ─── LangGraph-style state machine (manual impl, no external dep needed) ─────
// Nodes: retrieve → generate → evaluate → (refine → generate → evaluate)* → end

async function callClaude(systemPrompt, userPrompt, maxTokens = 8000) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes("...")) throw new Error("ANTHROPIC_API_KEY not configured");
  const client = new Anthropic({ apiKey: key });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return msg.content[0]?.text || "";
}

function parseJSON(raw) {
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return null; }
}

function extractSVG(raw) {
  const match = raw.match(/<svg[\s\S]*?<\/svg>/i);
  return match ? match[0] : raw;
}

// Node: generate SVG
async function nodeGenerate(state) {
  const { params, layout, ragContext, refinementHint, iteration } = state;
  const strategy = iteration === 0
    ? "Initial vastu-optimised layout"
    : `Refinement attempt ${iteration} — fixing violations from previous attempt`;

  const svgPrompt = buildFloorPlanSVGPromptWithRAG(params, layout, strategy, ragContext, refinementHint);
  const raw = await callClaude(
    "You are a world-class architectural SVG drafter. Output ONLY raw SVG — no markdown, no explanation. Start with <svg and end with </svg>.",
    svgPrompt,
    8000
  );
  const svgCode = extractSVG(raw);
  return { ...state, svgCode };
}

// Node: evaluate Vastu score
async function nodeEvaluate(state) {
  const { params, layout, svgCode } = state;
  const { buildBeliefCriticPrompt, buildBeliefContext } = await import("../../../lib/prompts.js");
  const { getVastuRemedies } = await import("../../../lib/vastuRules.js");
  const beliefCtx = buildBeliefContext(params.belief || "vastu");
  const raw = await callClaude(
    `You are a strict ${beliefCtx.label} expert. Respond ONLY as valid JSON with no markdown.`,
    buildBeliefCriticPrompt(svgCode, layout.rooms, params.plotW, params.plotH, params.belief || "vastu"),
    1800
  );
  const parsed = parseJSON(raw);
  if (!parsed) {
    // Fall back to local scoring
    const local = scoreVastuLayout(layout.rooms);
    return { ...state, vastuReport: local };
  }
  const remedies = getVastuRemedies(parsed.violations || []);
  return { ...state, vastuReport: { ...parsed, remedies } };
}

// Node: build refinement hint from violations
async function nodeRefine(state) {
  const { vastuReport, ragContext } = state;
  const refinementHint = buildRefinementHint(vastuReport, ragContext);
  return { ...state, refinementHint, iteration: state.iteration + 1 };
}

// ─── Main LangGraph workflow ──────────────────────────────────────────────────
async function runRefinementWorkflow(initialState) {
  const steps = [];
  let state = { ...initialState, iteration: 0, refinementHint: "" };

  // Node 1: Retrieve RAG context (if not already provided)
  if (!state.ragContext?.formattedContext) {
    const rag = await retrieveRAGContext(state.params);
    state = { ...state, ragContext: rag };
  }

  // Node 2: Initial generation
  steps.push({ node: "generate", iteration: 0 });
  state = await nodeGenerate(state);

  // Node 3: Evaluate
  steps.push({ node: "evaluate", iteration: 0 });
  state = await nodeEvaluate(state);
  steps.push({ node: "score", score: state.vastuReport?.score, iteration: 0 });

  // Conditional refinement loop (max MAX_ITERATIONS)
  let iteration = 0;
  while (state.vastuReport?.score < SCORE_TARGET && iteration < MAX_ITERATIONS) {
    // Node: Refine (build hint from violations)
    steps.push({ node: "refine", iteration: iteration + 1 });
    state = await nodeRefine(state);

    // Node: Re-generate with hints
    steps.push({ node: "generate", iteration: iteration + 1 });
    state = await nodeGenerate(state);

    // Node: Re-evaluate
    steps.push({ node: "evaluate", iteration: iteration + 1 });
    state = await nodeEvaluate(state);
    steps.push({ node: "score", score: state.vastuReport?.score, iteration: iteration + 1 });

    iteration++;
  }

  return { state, steps };
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { params, layout: layoutData, vastuReport: initialReport, ragContext } = body;

    if (!params || !layoutData) {
      return Response.json({ error: "Missing params or layout" }, { status: 400 });
    }

    // If score is already ≥ target, skip refinement
    if (initialReport?.score >= SCORE_TARGET) {
      return Response.json({
        refined: false,
        reason: `Score ${initialReport.score} already meets target ${SCORE_TARGET}`,
        svgCode: null,
        vastuReport: initialReport,
        steps: [],
      });
    }

    const layout = layoutData;
    const { state, steps } = await runRefinementWorkflow({
      params, layout,
      vastuReport: initialReport,
      ragContext: ragContext || null,
      svgCode: null,
    });

    return Response.json({
      refined:     true,
      svgCode:     state.svgCode,
      vastuReport: state.vastuReport,
      steps,
      finalScore:  state.vastuReport?.score,
      improved:    (state.vastuReport?.score || 0) > (initialReport?.score || 0),
    });

  } catch (err) {
    console.error("[rag-refine]", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
