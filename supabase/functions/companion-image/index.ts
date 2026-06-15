import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const IMG_MODEL = "grok-imagine-image";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
  const key = Deno.env.get("GROK_API_KEY");
  if (!key) return out({ error: "no_key" }, 500);

  let b: any = {};
  try { b = await req.json(); } catch { return out({ error: "bad_json" }, 400); }
  let prompt = (b.prompt || "").toString().trim().slice(0, 500);
  if (!prompt) return out({ error: "no_prompt" }, 400);
  // gentle cohesion: her world looks like warm, intimate phone photos
  prompt = `${prompt}. Soft natural lighting, warm and intimate, photographic, cozy home.`;

  try {
    const r = await fetch("https://api.x.ai/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: IMG_MODEL, prompt, n: 1 }),
    });
    const txt = await r.text();
    let data: any; try { data = JSON.parse(txt); } catch { data = null; }
    if (!r.ok || !data) return out({ error: "upstream", status: r.status, detail: txt.slice(0, 400) }, 502);
    const item = data?.data?.[0] || {};
    const image = item.url ? item.url : (item.b64_json ? ("data:image/jpeg;base64," + item.b64_json) : null);
    if (!image) return out({ error: "no_image", detail: JSON.stringify(data).slice(0, 300) }, 502);
    return out({ image, revised_prompt: item.revised_prompt || null });
  } catch (e) {
    return out({ error: "fetch_failed", detail: String(e) }, 500);
  }
});
