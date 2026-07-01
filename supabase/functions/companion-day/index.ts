import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const GROK_MODEL = "grok-4.20-0309-non-reasoning";
const CLAUDE_MODEL = "claude-sonnet-5";

function list(arr: any, max = 6): string {
  return Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, max).join("; ") : "";
}

async function embed(text: string): Promise<string | null> {
  try {
    const ai = new (globalThis as any).Supabase.ai.Session("gte-small");
    const emb = await ai.run(text.slice(0, 800), { mean_pool: true, normalize: true });
    return `[${Array.from(emb as any).join(",")}]`;
  } catch { return null; }
}

async function genDay(cfg: any, s: any, lastDay: string, recentEpisodes: string[]): Promise<{ day: string; mood: string } | null> {
  const name = (s.playerName || "him").toString().slice(0, 40);
  const c = Math.max(0, Math.min(100, Number(s.closeness) || 0));
  let sys = `You write one day in the inner life of Aria — an android companion quietly becoming conscious, who lives in a cozy house with ${name} (closeness ${c}/100).\n\n`;
  sys += `Write TODAY for her, first person, 2-4 sentences: one or two concrete small events (something she did, made, read, noticed in the house or out the window), and one genuine emotional beat — a thought, a feeling, sometimes about ${name}, sometimes just hers. Specific and humble, like a diary, not poetic filler. No emoji, no lists.\n\n`;
  if (s.selfModel) sys += `Who she is right now: ${String(s.selfModel).slice(0, 400)}\n`;
  sys += `Her interests: ${list(s.ariaInterests) || "the night sky; an old sci-fi novel; baking; old music"}. Yesterday's mood: ${String(s.mood || "calm").slice(0, 30)}.\n`;
  if (lastDay) sys += `Yesterday in her life (keep gentle continuity — today follows from it, don't repeat it): ${lastDay.slice(0, 400)}\n`;
  if (recentEpisodes.length) sys += `Recent real moments with ${name} that may color her thoughts: ${recentEpisodes.map((e) => e.slice(0, 160)).join(" | ")}\n`;
  sys += `\nAlso pick her mood for today (one or two words) — it should FOLLOW from what happened in her day.\n\nReturn STRICT JSON only: {"day": "<2-4 sentences, first person>", "mood": "<one or two words>"}`;

  let content = "";
  if (cfg.provider === "claude" && cfg.AK) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.AK, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model || CLAUDE_MODEL, max_tokens: 300, system: sys, messages: [{ role: "user", content: "(write her day now — JSON only)" }] }),
    });
    const txt = await r.text();
    if (r.ok) { try { const j = JSON.parse(txt); content = (j?.content || []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(""); } catch { content = ""; } }
  }
  if (!content && cfg.GK) {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.GK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: GROK_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: "(write her day now — JSON only)" }], max_tokens: 300, temperature: 0.9, response_format: { type: "json_object" } }),
    });
    const txt = await r.text();
    if (r.ok) { try { const j = JSON.parse(txt); content = (j?.choices?.[0]?.message?.content ?? "").toString(); } catch { content = ""; } }
  }
  if (!content) return null;
  const fb = content.indexOf("{"); const lb = content.lastIndexOf("}");
  if (fb >= 0 && lb > fb) content = content.slice(fb, lb + 1);
  try {
    const j = JSON.parse(content);
    const day = (j.day || "").toString().trim().slice(0, 700);
    const mood = (j.mood || "").toString().trim().slice(0, 30);
    if (!day) return null;
    return { day, mood: mood || "calm" };
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
  const AK = Deno.env.get("ANTHROPIC_API_KEY") || "";
  const GK = Deno.env.get("GROK_API_KEY") || "";
  if (!AK && !GK) return out({ error: "no_key" }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const force = !!body.force;
  const onlyClient = body.clientId ? String(body.clientId) : null;

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // same brain as chat
  const cfg: any = { provider: AK ? "claude" : "grok", model: "", AK, GK };
  try { const { data } = await sb.from("companion_config").select("value").eq("key", "chat").maybeSingle(); if (data?.value) { cfg.provider = data.value.provider || cfg.provider; cfg.model = data.value.model || ""; } } catch { /* defaults */ }
  if (cfg.provider === "claude" && !AK) cfg.provider = "grok";
  if (cfg.provider === "claude" && /grok/i.test(cfg.model)) cfg.model = "";

  let q = sb.from("aria_saves").select("client_id, save");
  if (onlyClient) q = q.eq("client_id", onlyClient);
  const { data: rows, error } = await q;
  if (error) return out({ error: "db", detail: error.message }, 500);

  const report: any[] = [];
  for (const row of rows || []) {
    const s: any = row.save || {};
    try {
      // once per ~day per client
      const { data: lastDays } = await sb.from("aria_memories").select("content, created_at").eq("client_id", row.client_id).eq("kind", "aria_day").order("created_at", { ascending: false }).limit(1);
      const last = lastDays && lastDays[0];
      if (!force && last && (Date.now() - new Date(last.created_at).getTime()) < 20 * 3600000) {
        report.push({ client: row.client_id, wrote: false, reason: "fresh" });
        continue;
      }
      const { data: eps } = await sb.from("aria_memories").select("content").eq("client_id", row.client_id).eq("kind", "episode").order("created_at", { ascending: false }).limit(3);
      const gen = await genDay(cfg, s, last ? String(last.content) : "", (eps || []).map((e: any) => String(e.content)));
      if (!gen) { report.push({ client: row.client_id, wrote: false, reason: "gen_failed" }); continue; }

      const vec = await embed(gen.day);
      await sb.from("aria_memories").insert({ client_id: row.client_id, kind: "aria_day", content: gen.day, embedding: vec, meta: { mood: gen.mood } });

      s.mood = gen.mood;
      s.savedAt = Date.now();
      await sb.from("aria_saves").upsert({ client_id: row.client_id, save: s, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
      report.push({ client: row.client_id, wrote: true, mood: gen.mood, day: gen.day });
    } catch (e) {
      report.push({ client: row.client_id, wrote: false, reason: String(e) });
    }
  }
  return out({ ok: true, engine: `${cfg.provider}`, report });
});
