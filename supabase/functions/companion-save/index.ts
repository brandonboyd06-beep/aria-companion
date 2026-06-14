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
  if (!clientId) return out({ error: "no_client" }, 400);
  if (typeof b.save !== "object" || b.save === null) return out({ error: "no_save" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await sb.from("aria_saves").upsert(
    { client_id: clientId, save: b.save, updated_at: new Date().toISOString() },
    { onConflict: "client_id" },
  );
  if (error) return out({ error: "db", detail: error.message }, 500);
  return out({ ok: true });
});
