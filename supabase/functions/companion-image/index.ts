import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const IMG_MODEL = "grok-imagine-image";
// Aria's locked likeness — matches the woman in the app's scene videos/stills, so any
// photo she "sends" is recognizably the same person. Applied only when a woman is in frame.
const ARIA_LOOK = "a 28-year-old woman with fair lightly-freckled skin, warm hazel-green eyes, full lips, a soft natural smile, an oval face with gentle features, and shoulder-length wavy chestnut-brown hair parted in the middle, slim natural figure, soft natural makeup";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
  const key = Deno.env.get("GROK_API_KEY");
  if (!key) return out({ error: "no_key" }, 500);

  let b: any = {};
  try { b = await req.json(); } catch { return out({ error: "bad_json" }, 400); }
  let prompt = (b.prompt || "").toString().trim().slice(0, 500);
  if (!prompt) return out({ error: "no_prompt" }, 400);
  // lock her likeness when she's in frame + keep her world looking like warm, intimate phone photos
  prompt = `${prompt}. If a woman appears in this photo she is always the same person, Aria: ${ARIA_LOOK}. Soft natural lighting, warm and intimate, candid phone photo, cozy home.`;

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
    let image: string | null = null;
    if (item.b64_json) {
      image = "data:image/jpeg;base64," + item.b64_json;
    } else if (item.url) {
      // inline the bytes as a data URL so the browser never has to hotlink xAI's image host
      try {
        const ir = await fetch(item.url);
        if (ir.ok) {
          const buf = new Uint8Array(await ir.arrayBuffer());
          let bin = ""; const chunk = 0x8000;
          for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
          const ct = ir.headers.get("content-type") || "image/jpeg";
          image = `data:${ct};base64,${btoa(bin)}`;
        } else { image = item.url; }
      } catch { image = item.url; }
    }
    if (!image) return out({ error: "no_image", detail: JSON.stringify(data).slice(0, 300) }, 502);
    return out({ image, revised_prompt: item.revised_prompt || null });
  } catch (e) {
    return out({ error: "fetch_failed", detail: String(e) }, 500);
  }
});
