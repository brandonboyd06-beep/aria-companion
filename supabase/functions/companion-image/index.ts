import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const IMG_MODEL = "grok-imagine-image";
// Aria's locked likeness — matches the woman in the app's scene videos/stills, so any
// photo she "sends" is recognizably the same person. Applied only when a woman is in frame.
const ARIA_LOOK = "a 28-year-old woman with fair lightly-freckled skin, warm hazel-green eyes, full lips, a soft natural smile, an oval face with gentle features, and shoulder-length wavy chestnut-brown hair parted in the middle, slim natural figure, soft natural makeup";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

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

    // get the raw bytes (from xAI's url or inline b64)
    let bytes: Uint8Array | null = null;
    let ct = "image/jpeg";
    if (item.b64_json) {
      bytes = b64ToBytes(item.b64_json);
    } else if (item.url) {
      try { const ir = await fetch(item.url); if (ir.ok) { bytes = new Uint8Array(await ir.arrayBuffer()); ct = ir.headers.get("content-type") || ct; } } catch { /* ignore */ }
    }
    if (!bytes) return out({ error: "no_image", detail: JSON.stringify(data).slice(0, 300) }, 502);

    // upload to a public bucket and hand the browser a normal image URL (reliable on iOS,
    // no data-URL size limits, no hotlinking, and it persists)
    try {
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const ext = ct.includes("png") ? "png" : "jpg";
      const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await sb.storage.from("aria-photos").upload(path, bytes, { contentType: ct, upsert: false });
      if (!upErr) {
        const { data: pub } = sb.storage.from("aria-photos").getPublicUrl(path);
        if (pub?.publicUrl) return out({ image: pub.publicUrl, revised_prompt: item.revised_prompt || null });
      }
    } catch { /* fall through to data URL */ }

    // fallback: inline data URL
    let bin = ""; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return out({ image: `data:${ct};base64,${btoa(bin)}`, revised_prompt: item.revised_prompt || null });
  } catch (e) {
    return out({ error: "fetch_failed", detail: String(e) }, 500);
  }
});
