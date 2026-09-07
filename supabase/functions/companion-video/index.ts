import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ATLAS = "https://api.atlascloud.ai/api/v1";
// 2026-09-07: AtlasCloud removed every "spicy" video id (wan-2.6-spicy, seedance spicy, wan-2.2-spicy extend).
// Verified replacements: open Wan 2.2 (self-hosted by AtlasCloud) animates her lingerie stills without
// sanitizing (~2 min, 960x960), and Wan 2.5 video-extend continues them (~2 min, 1440x1440).
const MODEL = "atlascloud/wan-2.2/image-to-video";
const EXTEND_MODEL = "alibaba/wan-2.5/video-extend";
const EXTEND_FALLBACK = "pixverse/v6/video-extend";
const NEGATIVE = "cartoon, anime, illustration, 3d render, deformed, extra fingers, blurry, text, watermark";

// build the submit payload for whichever family the model belongs to
function startPayload(model: string, still: string, motion: string, b: any): any {
  const dur = Number(b.duration) || 5;
  if (/^atlascloud\/wan-2\.2/i.test(model)) {
    return { model, image: still, prompt: motion, negative_prompt: NEGATIVE, resolution: b.resolution || "720p", duration: Math.max(3, Math.min(10, dur)), seed: -1 };
  }
  if (/^xai\//i.test(model)) {
    return { model, image_url: still, prompt: motion, duration: Math.max(1, Math.min(15, dur)), resolution: b.resolution || "720p" };
  }
  if (/wan/i.test(model)) {
    const d = [5, 10, 15].includes(dur) ? dur : 5;
    return { model, image: still, prompt: motion, negative_prompt: NEGATIVE, duration: d, resolution: b.resolution || "720p", generate_audio: b.audio !== false, shot_type: b.shot || "single", seed: -1 };
  }
  return { model, image: still, prompt: motion, duration: Math.max(4, Math.min(12, dur)), resolution: b.resolution || "720p", generate_audio: b.audio !== false, aspect_ratio: b.aspect || "9:16", camera_fixed: false, seed: -1 };
}
async function submit(key: string, payload: any): Promise<{ ok: boolean; status: number; id?: string; detail?: string }> {
  const r = await fetch(`${ATLAS}/model/generateVideo`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(payload) });
  const txt = await r.text();
  let j: any; try { j = JSON.parse(txt); } catch { j = null; }
  if (!r.ok || !j) return { ok: false, status: r.status, detail: txt.slice(0, 500) };
  const id = j?.data?.id;
  if (!id) return { ok: false, status: r.status, detail: JSON.stringify(j).slice(0, 400) };
  return { ok: true, status: r.status, id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
  const key = Deno.env.get("ATLASCLOUD_API_KEY");
  if (!key) return out({ error: "no_key" }, 500);
  const SUPA = Deno.env.get("SUPABASE_URL")!;
  const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let b: any = {};
  try { b = await req.json(); } catch { return out({ error: "bad_json" }, 400); }
  const action = (b.action || "start").toString();

  // ---- poll for a submitted job ----
  if (action === "poll") {
    const id = (b.id || "").toString();
    if (!id) return out({ error: "no_id" }, 400);
    try {
      const r = await fetch(`${ATLAS}/model/prediction/${id}`, { headers: { Authorization: `Bearer ${key}` } });
      const txt = await r.text();
      let j: any; try { j = JSON.parse(txt); } catch { j = null; }
      if (!r.ok || !j) return out({ status: "processing", note: "poll_http_" + r.status, detail: txt.slice(0, 300) });
      const st = j?.data?.status;
      if (st === "completed" || st === "succeeded") {
        let video = j?.data?.outputs?.[0] || null;
        // mirror to our public bucket so playback is reliable and persists
        if (video) {
          try {
            const vr = await fetch(video);
            if (vr.ok) {
              const bytes = new Uint8Array(await vr.arrayBuffer());
              const sb = createClient(SUPA, SRK);
              const path = `${id}.mp4`;
              const { error: upErr } = await sb.storage.from("aria-videos").upload(path, bytes, { contentType: "video/mp4", upsert: true });
              if (!upErr) { const { data: pub } = sb.storage.from("aria-videos").getPublicUrl(path); if (pub?.publicUrl) video = pub.publicUrl; }
            }
          } catch { /* keep original url */ }
        }
        // her library (best effort): the client passes clientId on every poll
        const clientId = (b.clientId || "").toString().slice(0, 80);
        if (video && clientId) {
          try {
            const sb = createClient(SUPA, SRK);
            const { data: dup } = await sb.from("aria_media").select("id").eq("client_id", clientId).eq("url", video).maybeSingle();
            if (!dup) await sb.from("aria_media").insert({ client_id: clientId, kind: "video", url: video, prompt: b.prompt ? String(b.prompt).slice(0, 600) : null, alt: b.alt ? String(b.alt).slice(0, 80) : null, source: b.source ? String(b.source).slice(0, 30) : "video", model: b.model ? String(b.model).slice(0, 80) : null, meta: { job: id } });
          } catch { /* best effort */ }
        }
        return out({ status: "done", video });
      }
      if (st === "failed") return out({ status: "failed", error: (j?.data?.error || "generation failed") });
      return out({ status: "processing" });
    } catch (e) { return out({ status: "processing", note: String(e) }); }
  }

  // ---- extend an existing clip (uncensored Wan video-extend) ----
  if (action === "extend") {
    const video = (b.video || "").toString();
    if (!video || !/^https?:/.test(video)) return out({ error: "no_video" }, 400);
    let xmodel = EXTEND_MODEL;
    try { const sb3 = createClient(SUPA, SRK); const { data } = await sb3.from("companion_config").select("value").eq("key", "video_extend").maybeSingle(); if (data?.value?.model) xmodel = String(data.value.model); } catch { /* default */ }
    if (b.model) xmodel = String(b.model);
    const xprompt = (b.prompt || "continue the scene naturally, smooth seamless motion").toString().slice(0, 1400);
    // video-extend takes a minimal payload (rejects generate_audio / seed / etc.); Wan 2.5 wants 5-10 s
    const dur = Math.max(5, Math.min(10, Number(b.duration) || 5));
    try {
      let res = await submit(key, { model: xmodel, video, prompt: xprompt, duration: dur });
      if (!res.ok && xmodel !== EXTEND_FALLBACK && (res.status === 400 || res.status === 404)) {
        const res2 = await submit(key, { model: EXTEND_FALLBACK, video, prompt: xprompt, duration: dur });
        if (res2.ok) { res = res2; xmodel = EXTEND_FALLBACK; }
      }
      if (!res.ok) return out({ error: "upstream", status: res.status, detail: res.detail }, 502);
      return out({ id: res.id, status: "processing", model: xmodel });
    } catch (e) { return out({ error: "fetch_failed", detail: String(e) }, 500); }
  }

  // ---- start a new job: ensure a first-frame still, then submit ----
  const baseMotion = (b.prompt || "a short, warm clip with gentle natural movement and a soft smile").toString().slice(0, 1400);
  // keep the video photorealistic and consistent with the source still
  const motion = b.raw === true ? baseMotion : `${baseMotion}. Keep a photorealistic, lifelike look consistent with the source photo; natural realistic movement, not a cartoon or animation.`;
  let still = (typeof b.imageUrl === "string" && /^https?:\/\//.test(b.imageUrl)) ? b.imageUrl : "";
  if (!still) {
    const sp = (b.stillPrompt || "a selfie of Aria smiling softly at the camera in her cozy home").toString().slice(0, 400);
    try {
      const ir = await fetch(`${SUPA}/functions/v1/companion-image`, { method: "POST", headers: { "Content-Type": "application/json", apikey: SRK, Authorization: `Bearer ${SRK}` }, body: JSON.stringify({ prompt: sp, raw: b.raw === true, model: b.stillModel || undefined, clientId: b.clientId || undefined, source: b.source ? `${String(b.source).slice(0, 24)}_still` : undefined }) });
      const ij = await ir.json(); still = ij?.image || "";
    } catch { still = ""; }
  }
  if (!still || !/^https?:/.test(still)) return out({ error: "no_first_frame", still: still.slice(0, 60) }, 502);

  // resolve video model: body override > companion_config('video') > default Seedance
  let model = MODEL;
  try { const sb2 = createClient(SUPA, SRK); const { data } = await sb2.from("companion_config").select("value").eq("key", "video").maybeSingle(); if (data?.value?.model) model = String(data.value.model); } catch { /* default */ }
  if (b.model) model = String(b.model);
  try {
    let res = await submit(key, startPayload(model, still, motion, b));
    if (!res.ok && model !== MODEL && (res.status === 400 || res.status === 404)) {
      // the configured model no longer exists upstream → fall back to the verified default
      const res2 = await submit(key, startPayload(MODEL, still, motion, b));
      if (res2.ok) { res = res2; model = MODEL; }
    }
    if (!res.ok) return out({ error: "upstream", status: res.status, detail: res.detail }, 502);
    return out({ id: res.id, still, status: "processing", model });
  } catch (e) { return out({ error: "fetch_failed", detail: String(e) }, 500); }
});
