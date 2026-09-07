import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ATLAS = "https://api.atlascloud.ai/api/v1";
// Aria's look: a consistent, photorealistic human. NOT cartoon/3D.
// 2026-09-07 bake-off (9 models x 4 tiers, 3 blind judges): z-image/turbo and qwen-image-2.0-pro were the only
// models rendering every tier uncensored; z-image won on identity consistency, ~9 s and $0.005/image
// (qwen: most photoreal skin, ~40 s, $0.06, 6-7 MB PNGs). Flux-dev sanitized the topless tier.
const DEFAULT_MODEL = "z-image/turbo";
const ARIA_BASE = "Aria, the same beautiful photorealistic woman every time: mid-20s, warm sun-kissed tan skin, a fit and toned athletic figure, flawless smooth skin, long wavy chestnut-brown hair, warm brown eyes, full lips, and a radiant friendly smile";
// the bust note only when the scene is already intimate — otherwise a plain kitchen selfie tends to lose its top
const INTIMATE = /\b(lingerie|bikini|swimsuit|bra\b|panties|topless|nude|naked|undress|shower|bath|bed(room)?|sheets?|seductive|sexy|sultry|tease|strip|cleavage|bust|breasts?|boobs?|thong|robe)\b/i;
function ariaLook(prompt: string): string { return INTIMATE.test(prompt) ? ARIA_BASE.replace("flawless smooth skin,", "flawless smooth skin, a natural C-cup bust,") : ARIA_BASE; }
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

// ---- photo editing: change an existing picture of her by instruction ----
// 2026-09-07 edit bake-off (7 editors x 4 edits on the same lingerie base): qwen-image-2.0 (standard) was the only
// editor that made every edit including the topless one, kept her identity, and ran in 9-15 s (~$0.02);
// the Pro editor was close but partial on the topless edit and slower; Kontext/Seedream sanitized it.
const DEFAULT_EDIT_MODEL = "qwen/qwen-image-2.0/edit";
const EDIT_FALLBACK = "alibaba/wan-2.7/image-edit";
// payload shape per model family (AtlasCloud rejects unknown fields on some models)
function editPayloads(model: string, prompt: string, url: string): any[] {
  if (/flux-kontext/i.test(model)) return [{ model, prompt, image: url, enable_safety_checker: false, guidance_scale: 2.5 }, { model, prompt, image: url }];
  if (/^(qwen\/|qwen-image|alibaba\/qwen-image|alibaba\/wan-2\.[67]\/image-edit|bytedance\/seedream)/i.test(model)) return [{ model, prompt, images: [url] }, { model, prompt, image: url }];
  if (/seedream/i.test(model)) return [{ model, prompt, images: [url], output_format: "jpeg" }, { model, prompt, image: url }];
  return [{ model, prompt, images: [url] }, { model, prompt, image: url }, { model, prompt, image_url: url }];
}
async function genAtlasEdit(model: string, prompt: string, url: string): Promise<{ image: string | null; detail?: string }> {
  const key = Deno.env.get("ATLASCLOUD_API_KEY"); if (!key) return { image: null, detail: "no_key" };
  let lastDetail = "";
  for (const payload of editPayloads(model, prompt, url)) {
    const r = await fetch(`${ATLAS}/model/generateImage`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(payload) });
    const txt = await r.text(); let j: any; try { j = JSON.parse(txt); } catch { j = null; }
    if (!r.ok || !j) { lastDetail = `${r.status} ${txt.slice(0, 200)}`; if (r.status === 400 || r.status === 422) continue; return { image: null, detail: lastDetail }; }
    const id = j?.data?.id; if (!id) return { image: j?.data?.outputs?.[0] || null, detail: "no_id" };
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const pr = await fetch(`${ATLAS}/model/prediction/${id}`, { headers: { Authorization: `Bearer ${key}` } });
      let pj: any; try { pj = await pr.json(); } catch { pj = null; }
      const st = pj?.data?.status;
      if (st === "completed" || st === "succeeded") return { image: pj?.data?.outputs?.[0] || null };
      if (st === "failed") return { image: null, detail: `failed: ${JSON.stringify(pj?.data?.error || "").slice(0, 200)}` };
    }
    return { image: null, detail: "timeout" };
  }
  return { image: null, detail: lastDetail || "no_payload_accepted" };
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

  const SUPA = Deno.env.get("SUPABASE_URL")!; const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPA, SRK);
  const clientId = (b.clientId || "").toString().slice(0, 80);

  // mirror any produced image into the public bucket and remember it in her library
  async function deliver(src: string, meta: { model: string; provider: string; source: string; extra?: any }): Promise<Response> {
    const got = await toBytes(src);
    if (got) {
      try {
        const ext = got.ct.includes("png") ? "png" : "jpg";
        const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await sb.storage.from("aria-photos").upload(path, got.bytes, { contentType: got.ct, upsert: false });
        if (!upErr) {
          const { data: pub } = sb.storage.from("aria-photos").getPublicUrl(path);
          if (pub?.publicUrl) {
            if (clientId) {
              try { await sb.from("aria_media").insert({ client_id: clientId, kind: "photo", url: pub.publicUrl, prompt: (b.prompt || "").toString().slice(0, 600), alt: b.alt ? String(b.alt).slice(0, 80) : null, source: meta.source, model: meta.model, meta: { provider: meta.provider, ...(meta.extra || {}) } }); } catch { /* library is best effort */ }
            }
            return out({ image: pub.publicUrl, provider: meta.provider, model: meta.model });
          }
        }
      } catch { /* fall through */ }
    }
    return out({ image: src, provider: meta.provider, model: meta.model });
  }

  // ---- edit an existing photo of her by instruction ----
  if ((b.action || "") === "edit") {
    const imageUrl = (typeof b.imageUrl === "string" && /^https?:\/\//.test(b.imageUrl)) ? b.imageUrl : "";
    if (!imageUrl) return out({ error: "no_image" }, 400);
    let emodel = DEFAULT_EDIT_MODEL, efallback = EDIT_FALLBACK;
    try { const { data } = await sb.from("companion_config").select("value").eq("key", "image_edit").maybeSingle(); if (data?.value?.model) emodel = String(data.value.model); if (data?.value?.alt) efallback = String(data.value.alt); } catch { /* default */ }
    if (b.model) emodel = String(b.model);
    const instruction = `Edit this photo of Aria: ${prompt}. Keep her the same person (same face, hair, skin tone and body) and keep everything not mentioned unchanged. Photorealistic, natural lighting, like a real photograph.`;
    let res = await genAtlasEdit(emodel, instruction, imageUrl);
    let usedEditor = emodel;
    if (!res.image && !b.model && efallback && efallback !== emodel) {
      // the judges' runner-up (Wan 2.7, also uncensored and identity-safe) when the primary editor fails
      const res2 = await genAtlasEdit(efallback, instruction, imageUrl);
      if (res2.image) { res = res2; usedEditor = efallback; }
    }
    if (!res.image) return out({ error: "edit_failed", model: emodel, detail: res.detail || "" }, 502);
    return await deliver(res.image, { model: usedEditor, provider: "atlascloud", source: b.source ? String(b.source).slice(0, 30) : "edit", extra: { from: imageUrl, instruction: prompt.slice(0, 300) } });
  }

  prompt = `${prompt}. If a woman appears, she is always the same person: ${ariaLook(prompt)}. ${ARIA_STYLE}`;

  // resolve configured provider/model (swappable without redeploy)
  let provider = "atlascloud", model = DEFAULT_MODEL;
  try { const { data } = await sb.from("companion_config").select("value").eq("key", "image").maybeSingle(); if (data?.value) { provider = data.value.provider || provider; model = data.value.model || model; } } catch { /* defaults */ }
  if (b.model) model = String(b.model);
  if (b.provider) provider = String(b.provider);

  // generate (with cross-provider fallback so a still always comes back)
  let src: string | null = null; let used = provider;
  try { src = provider === "grok" ? await genGrok(prompt) : await genAtlas(model, prompt); } catch { src = null; }
  if (!src) { used = provider === "grok" ? "atlascloud" : "grok"; try { src = used === "grok" ? await genGrok(prompt) : await genAtlas(model, prompt); } catch { src = null; } }
  if (!src) return out({ error: "gen_failed" }, 502);
  if (used === "grok") model = "grok-imagine-image"; // truthful: this is what actually drew it

  return await deliver(src, { model, provider: used, source: b.source ? String(b.source).slice(0, 30) : "chat" });
});
