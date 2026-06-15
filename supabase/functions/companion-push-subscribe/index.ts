import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const out = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

  let b: any = {};
  try { b = await req.json(); } catch { return out({ error: "bad_json" }, 400); }
  const clientId = (b.clientId || "").toString().slice(0, 80);
  const sub = b.subscription;
  const action = (b.action || "subscribe").toString();
  if (!clientId) return out({ error: "no_client" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (action === "unsubscribe") {
    const endpoint = (sub && sub.endpoint) ? sub.endpoint : (b.endpoint || "");
    if (endpoint) await sb.from("aria_push_subs").delete().eq("endpoint", endpoint);
    return out({ ok: true });
  }

  if (!sub || typeof sub !== "object" || !sub.endpoint) return out({ error: "no_subscription" }, 400);
  const { error } = await sb.from("aria_push_subs").upsert(
    { endpoint: sub.endpoint, client_id: clientId, subscription: sub, created_at: new Date().toISOString() },
    { onConflict: "endpoint" },
  );
  if (error) return out({ error: "db", detail: error.message }, 500);
  return out({ ok: true });
});
