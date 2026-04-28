import { retrieveRAGContext } from "../../../lib/rag/retriever.js";
import { getIngestionStats } from "../../../lib/rag/vectorStore.js";

export async function POST(req) {
  try {
    const params = await req.json();
    const { plotW, plotH, bhk, facing, belief = "vastu" } = params;

    if (!plotW || !plotH || !bhk || !facing) {
      return Response.json({ error: "Missing required params: plotW, plotH, bhk, facing" }, { status: 400 });
    }

    const result = await retrieveRAGContext({ plotW, plotH, bhk, facing, belief });
    const stats  = await getIngestionStats().catch(() => ({ total: 0 }));

    return Response.json({
      formattedContext: result.formattedContext,
      zoneRules:        result.zoneRules,
      docsFound:        result.docs.length,
      source:           result.source,
      ingestionStats:   stats,
    });
  } catch (err) {
    console.error("[rag-retrieve]", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
