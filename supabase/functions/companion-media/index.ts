import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Aria's media library: everything she has sent him, per account.
//   { action:"list",   clientId, kind?: "photo"|"video", limit?, before? }  -> { items }
//   { action:"add",    clientId, kind, url, prompt?, alt?, source?, model?, meta? } -> { item }  (client-side fallback logger)
//   { action:"delete", clientId, id } -> { ok }
//   { action:"adopt",  clientId, fromClientId } -> { ok, moved }  (a linked device brings its library along)
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const OWN_HOST = /^https:\/\/mymunodjaxymhbnhjwjx\.supabase\.co\/storage\/v1\/object\/public\/aria-(photos|videos)\//;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
  let b: any = {};
  try { b = await req.json(); } catch { return out({ error: "bad_json" }, 400); }
  const clientId = (b.clientId || "").toString().slice(0, 80);
  if (!clientId) return out({ error: "no_client" }, 400);
  const action = (b.action || "list").toString();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    if (action === "list") {
      const limit = Math.max(1, Math.min(300, Number(b.limit) || 200));
      let q = sb.from("aria_media").select("id, kind, url, prompt, alt, source, model, meta, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(limit);
      if (b.kind === "photo" || b.kind === "video") q = q.eq("kind", b.kind);
      if (typeof b.before === "string" && b.before) q = q.lt("created_at", b.before);
      const { data, error } = await q;
      if (error) return out({ error: "db", detail: error.message }, 500);
      return out({ items: data || [] });
    }
    if (action === "add") {
      const kind = b.kind === "video" ? "video" : "photo";
      const url = (b.url || "").toString().slice(0, 600);
      if (!OWN_HOST.test(url)) return out({ error: "bad_url" }, 400);
      const row = { client_id: clientId, kind, url, prompt: b.prompt ? String(b.prompt).slice(0, 600) : null, alt: b.alt ? String(b.alt).slice(0, 80) : null, source: b.source ? String(b.source).slice(0, 30) : null, model: b.model ? String(b.model).slice(0, 80) : null, meta: (b.meta && typeof b.meta === "object") ? b.meta : {} };
      const { data: dup } = await sb.from("aria_media").select("id").eq("client_id", clientId).eq("url", url).maybeSingle();
      if (dup) return out({ item: dup, existed: true });
      const { data, error } = await sb.from("aria_media").insert(row).select("id, kind, url, prompt, alt, source, model, meta, created_at").maybeSingle();
      if (error) return out({ error: "db", detail: error.message }, 500);
      return out({ item: data });
    }
    if (action === "adopt") {
      // a device just linked to another account: bring its old library rows along (idempotent)
      const from = (b.fromClientId || "").toString().slice(0, 80);
      if (!from || from === clientId) return out({ error: "bad_from" }, 400);
      const { data: rows, error } = await sb.from("aria_media").select("kind, url, prompt, alt, source, model, meta, created_at").eq("client_id", from).order("created_at", { ascending: true }).limit(1000);
      if (error) return out({ error: "db", detail: error.message }, 500);
      let moved = 0;
      for (const r of rows || []) {
        try {
          const { data: dup } = await sb.from("aria_media").select("id").eq("client_id", clientId).eq("url", r.url).maybeSingle();
          if (dup) continue;
          const { error: insErr } = await sb.from("aria_media").insert({ client_id: clientId, kind: r.kind, url: r.url, prompt: r.prompt, alt: r.alt, source: r.source, model: r.model, meta: { ...(r.meta || {}), adopted_from: from }, created_at: r.created_at });
          if (!insErr) moved++;
        } catch { /* best effort */ }
      }
      return out({ ok: true, moved, seen: (rows || []).length });
    }
    if (action === "delete") {
      const id = (b.id || "").toString();
      if (!id) return out({ error: "no_id" }, 400);
      const { error } = await sb.from("aria_media").delete().eq("client_id", clientId).eq("id", id);
      if (error) return out({ error: "db", detail: error.message }, 500);
      return out({ ok: true });
    }
    return out({ error: "unknown_action" }, 400);
  } catch (e) {
    return out({ error: "fetch_failed", detail: String(e) }, 500);
  }
});
