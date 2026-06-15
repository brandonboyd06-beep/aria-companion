import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ATLAS = "https://api.atlascloud.ai/api/v1";
const MODEL = "bytedance/seedance-v1.5-pro/image-to-video-spicy";

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
      if (!r.ok || !j) return out({ status: "processing", note: "poll_http_" + r.status });
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
        return out({ status: "done", video });
      }
      if (st === "failed") return out({ status: "failed", error: (j?.data?.error || "generation failed") });
      return out({ status: "processing" });
    } catch (e) { return out({ status: "processing", note: String(e) }); }
  }

  // ---- start a new job: ensure a first-frame still, then submit ----
  const baseMotion = (b.prompt || "a short, warm clip with gentle natural movement and a soft smile").toString().slice(0, 1400);
  // keep the animated look consistent with the still / the app's 3D scenes
  const motion = `${baseMotion}. Maintain the exact 3D animated Pixar/Disney CGI style of the source image; smooth stylized animation, not photorealistic.`;
  let still = b.imageUrl ? String(b.imageUrl) : "";
  if (!still) {
    const sp = (b.stillPrompt || "a selfie of Aria smiling softly at the camera in her cozy home").toString().slice(0, 400);
    try {
      const ir = await fetch(`${SUPA}/functions/v1/companion-image`, { method: "POST", headers: { "Content-Type": "application/json", apikey: SRK, Authorization: `Bearer ${SRK}` }, body: JSON.stringify({ prompt: sp }) });
      const ij = await ir.json(); still = ij?.image || "";
    } catch { still = ""; }
  }
  if (!still || !/^https?:/.test(still)) return out({ error: "no_first_frame", still: still.slice(0, 60) }, 502);

  const payload = {
    model: MODEL,
    image: still,
    prompt: motion,
    duration: Math.max(4, Math.min(12, Number(b.duration) || 5)),
    resolution: b.resolution === "480p" ? "480p" : "720p",
    generate_audio: b.audio !== false,
    aspect_ratio: b.aspect || "9:16",
    camera_fixed: false,
    seed: -1,
  };
  try {
    const r = await fetch(`${ATLAS}/model/generateVideo`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(payload) });
    const txt = await r.text();
    let j: any; try { j = JSON.parse(txt); } catch { j = null; }
    if (!r.ok || !j) return out({ error: "upstream", status: r.status, detail: txt.slice(0, 400) }, 502);
    const id = j?.data?.id;
    if (!id) return out({ error: "no_id", detail: JSON.stringify(j).slice(0, 300) }, 502);
    return out({ id, still, status: "processing" });
  } catch (e) { return out({ error: "fetch_failed", detail: String(e) }, 500); }
});
