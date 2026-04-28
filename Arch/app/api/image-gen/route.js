import OpenAI from "openai";

const FACING_RULES = {
  North:  "main entrance on the north wall, living area in the north-east quadrant",
  South:  "main entrance on the south wall, kitchen in the south-east quadrant",
  East:   "main entrance on the east wall, puja/meditation room in the north-east",
  West:   "main entrance on the west wall, master bedroom in the south-west quadrant",
};

function buildImagePrompt(params) {
  const { plotW, plotH, bhk, facing, city, budget, floors } = params;
  const facingRule = FACING_RULES[facing] || FACING_RULES.North;
  const floorLabel = floors === 1 ? "single-storey" : floors === 2 ? "double-storey duplex" : "triple-storey";

  return [
    `Architectural floor plan drawing of a ${plotW}×${plotH} feet ${bhk}BHK ${floorLabel} Indian residential house.`,
    `${facing}-facing plot — ${facingRule}.`,
    "Vastu Shastra compliant layout:",
    `  • Master bedroom in SW corner`,
    `  • Kitchen in SE corner`,
    `  • Puja/meditation room in NE corner`,
    `  • Toilets/bathrooms in NW corner, never in NE`,
    `  • Main entrance door on ${facing} wall`,
    `  • Living room near entrance, open to north/east`,
    `  • Guest bedroom in NW or west wing`,
    `Rooms required: living room, dining area, kitchen, ${bhk} bedroom(s), ${Math.ceil(bhk / 2) + 1} bathroom(s), puja room, foyer/entrance.`,
    `City: ${city} (follow local building setbacks).`,
    `Budget tier: ${budget}.`,
    "Style: clean technical architectural plan view (top-down 2D blueprint), black lines on white background,",
    "room labels in English, dimension annotations in feet, north arrow in top-right corner,",
    "scale bar at bottom, walls shown as thick black lines, doors as arcs, windows as thin parallel lines.",
    "No 3D, no perspective, no furniture (outlines only), no colour fills — pure architectural drawing.",
  ].join(" ");
}

export async function POST(request) {
  const params = await request.json();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.includes("...") || apiKey.length < 20) {
    return Response.json({ error: "OpenAI API key not configured" }, { status: 503 });
  }

  const prompt = buildImagePrompt(params);
  const client = new OpenAI({ apiKey });

  try {
    const response = await client.images.generate({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size: "1024x1024",
      quality: "standard",
    });

    const imageData = response.data?.[0];
    if (!imageData) {
      return Response.json({ error: "No image returned from OpenAI" }, { status: 502 });
    }

    // gpt-image-1 returns base64 b64_json; convert to data URL
    if (imageData.b64_json) {
      return Response.json({ url: `data:image/png;base64,${imageData.b64_json}` });
    }

    // url fallback (older models)
    return Response.json({ url: imageData.url });
  } catch (e) {
    console.error("[image-gen]", e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
