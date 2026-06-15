import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ATLAS = "https://api.atlascloud.ai/api/v1";
// Aria's look: a consistent, photorealistic human (uncensored Flux). NOT cartoon/3D.
const ARIA_LOOK = "Aria, the same beautiful photorealistic woman every time: mid-20s, warm sun-kissed tan skin, a fit and toned athletic figure, flawless smooth skin, a natural C-cup bust, long wavy chestnut-brown hair, warm brown eyes, full lips, and a radiant friendly smile";
const ARIA_STYLE = "Photorealistic, captured like a real high-quality photograph, realistic skin texture and detail, natural soft lighting, lifelike and cinematic. Not a cartoon, not 3D animation, not an illustration.";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// AtlasCloud async image gen (Seedream / Flux / etc). Returns a hosted image URL or null.
async function genAtlas(model: string, prompt: string): Promise<string | null> {
  const key = Deno.env.get("ATLASCLOUD_API_KEY"); if (!key) return null;
  const r = await fetch(`${ATLAS}/model/generateImage`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, prompt }),
  });
  const txt = await r.text(); let j: any; try { j = JSON.parse(txt); } catch { j = null; }
  if (!r.ok || !j) return null;
  const id = j?.data?.id; if (!id) { return j?.data?.outputs?.[0] || null; }
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const pr = await fetch(`${ATLAS}/model/prediction/${id}`, { headers: { Authorization: `Bearer ${key}` } });
    let pj: any; try { pj = await pr.json(); } catch { pj = null; }
    const st = pj?.data?.status;
    if (st === "completed" || st === "succeeded") return pj?.data?.outputs?.[0] || null;
    if (st === "failed") return null;
  }
  return null;
}

// xAI grok image (fallback). Returns a hosted image URL or null.
async function genGrok(prompt: string): Promise<string | null> {
  const key = Deno.env.get("GROK_API_KEY"); if (!key) return null;
  const r = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "grok-imagine-image", prompt, n: 1 }),
  });
  if (!r.ok) return null;
  let j: any; try { j = await r.json(); } catch { return null; }
  const item = j?.data?.[0] || {};
  if (item.url) return item.url;
  if (item.b64_json) return "data:image/jpeg;base64," + item.b64_json;
  return null;
}

async function toBytes(src: string): Promise<{ bytes: Uint8Array; ct: string } | null> {
  if (src.startsWith("data:")) {
    const m = src.match(/^data:([^;]+);base64,(.*)$/); if (!m) return null;
    return { bytes: b64ToBytes(m[2]), ct: m[1] };
  }
  try { const r = await fetch(src); if (!r.ok) return null; return { bytes: new Uint8Array(await r.arrayBuffer()), ct: r.headers.get("content-type") || "image/jpeg" }; } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

  let b: any = {};
  try { b = await req.json(); } catch { return out({ error: "bad_json" }, 400); }
  let prompt = (b.prompt || "").toString().trim().slice(0, 600);
  if (!prompt) return out({ error: "no_prompt" }, 400);
  prompt = `${prompt}. If a woman appears, she is always the same person: ${ARIA_LOOK}. ${ARIA_STYLE}`;

  const SUPA = Deno.env.get("SUPABASE_URL")!; const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPA, SRK);

  // resolve configured provider/model (swappable without redeploy)
  let provider = "atlascloud", model = "bytedance/seedream-v4";
  try { const { data } = await sb.from("companion_config").select("value").eq("key", "image").maybeSingle(); if (data?.value) { provider = data.value.provider || provider; model = data.value.model || model; } } catch { /* defaults */ }
  if (b.model) model = String(b.model);
  if (b.provider) provider = String(b.provider);

  // generate (with cross-provider fallback so a still always comes back)
  let src: string | null = null; let used = provider;
  try { src = provider === "grok" ? await genGrok(prompt) : await genAtlas(model, prompt); } catch { src = null; }
  if (!src) { used = provider === "grok" ? "atlascloud" : "grok"; try { src = used === "grok" ? await genGrok(prompt) : await genAtlas(model, prompt); } catch { src = null; } }
  if (!src) return out({ error: "gen_failed" }, 502);

  // mirror to our public bucket → reliable, persistent URL
  const got = await toBytes(src);
  if (got) {
    try {
      const ext = got.ct.includes("png") ? "png" : "jpg";
      const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await sb.storage.from("aria-photos").upload(path, got.bytes, { contentType: got.ct, upsert: false });
      if (!upErr) { const { data: pub } = sb.storage.from("aria-photos").getPublicUrl(path); if (pub?.publicUrl) return out({ image: pub.publicUrl, provider: used, model }); }
    } catch { /* fall through */ }
  }
  // last resort: hand back whatever URL we have
  return out({ image: src, provider: used, model });
});
