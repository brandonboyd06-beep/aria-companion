import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Aria's voice. ElevenLabs when ELEVENLABS_API_KEY is set (production), else Replicate MiniMax,
// else the browser falls back to speechSynthesis on its own.
//
// TTS:            { text, elVoice?, model?, stability?, style?, speed?, rpVoice?, pitch?, emotion? }
// Management (requires adminToken = companion_config('admin').token):
//   { action:"voices" }                          -> voices in the ElevenLabs account
//   { action:"search", query, pageSize? }        -> ElevenLabs shared voice library (female, English)
//   { action:"add", publicUserId, voiceId, name }-> add a shared voice to the account
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const DEFAULT_EL_VOICE = "EXAVITQu4vr4xnSDxMaL";
const DEFAULT_EL_MODEL = "eleven_turbo_v2_5";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const EL = Deno.env.get("ELEVENLABS_API_KEY");
  const RP = Deno.env.get("REPLICATE_API_KEY") || Deno.env.get("REPLICATE_API_TOKEN");

  // ---- management actions (service role only) ----
  const action = typeof body.action === "string" ? body.action : "";
  if (action) {
    // gate: the operator token stored in companion_config('admin') (service-role-only table)
    let adminToken = "";
    try {
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await sb.from("companion_config").select("value").eq("key", "admin").maybeSingle();
      adminToken = (data?.value?.token || "").toString();
    } catch { adminToken = ""; }
    if (!adminToken || String(body.adminToken || "") !== adminToken) return out({ error: "forbidden" }, 403);
    if (!EL) return out({ error: "no_elevenlabs_key" }, 500);
    const h = { "xi-api-key": EL, "Content-Type": "application/json" };
    try {
      if (action === "voices") {
        const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: h });
        const j = await r.json();
        const voices = (j?.voices || []).map((v: any) => ({ voice_id: v.voice_id, name: v.name, category: v.category, labels: v.labels || {}, description: v.description || "", preview_url: v.preview_url || null }));
        return out({ ok: r.ok, status: r.status, voices });
      }
      if (action === "search") {
        const q = new URLSearchParams({ page_size: String(Math.min(50, Number(body.pageSize) || 30)), gender: body.gender || "female", language: body.language || "en" });
        if (body.query) q.set("search", String(body.query).slice(0, 80));
        if (body.useCase) q.set("use_cases", String(body.useCase));
        if (body.descriptive) q.set("descriptives", String(body.descriptive));
        if (body.age) q.set("age", String(body.age));
        if (body.sort) q.set("sort", String(body.sort));
        const r = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${q}`, { headers: h });
        const j = await r.json();
        const voices = (j?.voices || []).map((v: any) => ({ public_owner_id: v.public_owner_id, voice_id: v.voice_id, name: v.name, gender: v.gender, age: v.age, accent: v.accent, descriptive: v.descriptive, use_case: v.use_case, description: (v.description || "").slice(0, 240), preview_url: v.preview_url, free_users_allowed: v.free_users_allowed, usage_1y: v.usage_character_count_1y, cloned_by: v.cloned_by_count, category: v.category }));
        return out({ ok: r.ok, status: r.status, has_more: !!j?.has_more, voices });
      }
      if (action === "add") {
        const pu = String(body.publicUserId || ""), vid = String(body.voiceId || ""), name = String(body.name || "Aria voice").slice(0, 60);
        if (!pu || !vid) return out({ error: "bad_add" }, 400);
        const r = await fetch(`https://api.elevenlabs.io/v1/voices/add/${encodeURIComponent(pu)}/${encodeURIComponent(vid)}`, { method: "POST", headers: h, body: JSON.stringify({ new_name: name }) });
        const t = await r.text();
        return out({ ok: r.ok, status: r.status, detail: t.slice(0, 400) });
      }
      return out({ error: "unknown_action" }, 400);
    } catch (e) {
      return out({ error: "fetch_failed", detail: String(e) }, 500);
    }
  }

  // ---- text to speech ----
  const text = (typeof body.text === "string" ? body.text : "").replace(/\*[^*]*\*/g, " ").replace(/[_*#>`~]/g, "").replace(/\s+/g, " ").trim().slice(0, 800);
  if (!text) return out({ error: "no_text" }, 400);
  try {
    if (EL) {
      const voice = (typeof body.elVoice === "string" && /^[A-Za-z0-9]{10,40}$/.test(body.elVoice)) ? body.elVoice : DEFAULT_EL_VOICE;
      const model = (typeof body.model === "string" && /^eleven_[a-z0-9_]+$/.test(body.model)) ? body.model : DEFAULT_EL_MODEL;
      const clamp = (v: any, lo: number, hi: number, d: number) => (typeof v === "number" && v >= lo && v <= hi) ? v : d;
      const isV3 = /^eleven_v3/.test(model);
      const voice_settings: any = isV3
        ? { stability: [0, 0.5, 1].includes(body.stability) ? body.stability : 0.5 }
        : { stability: clamp(body.stability, 0, 1, 0.35), similarity_boost: clamp(body.similarity, 0, 1, 0.8), style: clamp(body.style, 0, 1, 0.55), use_speaker_boost: true, speed: clamp(body.speed, 0.7, 1.2, 1.0) };
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": EL, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: model, voice_settings }),
      });
      if (!r.ok) return out({ error: "elevenlabs", status: r.status, detail: (await r.text()).slice(0, 300) }, 502);
      const b64 = encodeBase64(new Uint8Array(await r.arrayBuffer()));
      return out({ provider: "elevenlabs", voice, model, audio: `data:audio/mpeg;base64,${b64}` });
    }
    if (RP) {
      const speed = (typeof body.speed === "number" && body.speed >= 0.5 && body.speed <= 2) ? body.speed : 1;
      const input: any = { text, voice_id: body.rpVoice || "Calm_Woman", speed, language_boost: "English" };
      if (typeof body.pitch === "number") input.pitch = body.pitch;
      if (typeof body.emotion === "string") input.emotion = body.emotion;
      const sub = await fetch("https://api.replicate.com/v1/models/minimax/speech-02-turbo/predictions", {
        method: "POST", headers: { Authorization: `Bearer ${RP}`, "Content-Type": "application/json", Prefer: "wait" }, body: JSON.stringify({ input }),
      });
      let d: any = await sub.json();
      let tries = 0;
      while (d && d.status && d.status !== "succeeded" && d.status !== "failed" && d.urls && d.urls.get && tries < 25) {
        await new Promise((r) => setTimeout(r, 900));
        d = await (await fetch(d.urls.get, { headers: { Authorization: `Bearer ${RP}` } })).json();
        tries++;
      }
      if (!d || d.status !== "succeeded") return out({ error: "replicate", status: d?.status, detail: JSON.stringify(d?.error || d).slice(0, 300) }, 502);
      const url = Array.isArray(d.output) ? d.output[0] : d.output;
      const ab = await (await fetch(url)).arrayBuffer();
      return out({ provider: "replicate", audio: `data:audio/mpeg;base64,${encodeBase64(new Uint8Array(ab))}` });
    }
    return out({ error: "no_tts_key", need: ["ELEVENLABS_API_KEY", "REPLICATE_API_KEY"] });
  } catch (e) {
    return out({ error: "fetch_failed", detail: String(e) }, 500);
  }
});
