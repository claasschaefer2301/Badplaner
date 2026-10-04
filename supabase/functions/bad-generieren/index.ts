// Edge Function "bad-generieren"
// Nimmt ein Vorher-Foto + ausgewählte Vigour-Produkte und lässt Gemini das neue Bad einzeichnen.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-image";
const ASPECTS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"];

function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Sucht in einer beliebigen Gemini-Antwort das erste Bild (robust gegen unterschiedliche Antwortformen)
function findImage(node: any): { data: string; mime: string } | null {
  if (!node || typeof node !== "object") return null;
  const inline = node.inlineData ?? node.inline_data;
  if (inline?.data) return { data: inline.data, mime: inline.mimeType ?? inline.mime_type ?? "image/png" };
  if (typeof node.data === "string" && node.data.length > 1000 &&
      (String(node.mime_type ?? node.mimeType ?? "").startsWith("image") || node.type === "image")) {
    return { data: node.data, mime: node.mime_type ?? node.mimeType ?? "image/png" };
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const r = findImage(v);
    if (r) return r;
  }
  return null;
}

type Img = { mime: string; data: string };

async function callGemini(key: string, prompt: string, images: Img[], aspect: string, size: string) {
  // 1. Versuch: Interactions-API (aktuelle Doku)
  const r1 = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { type: "text", text: prompt },
        ...images.map((i) => ({ type: "image", mime_type: i.mime, data: i.data })),
      ],
      response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: aspect, image_size: size },
    }),
  });
  let t1 = "";
  if (r1.ok) {
    const img = findImage(await r1.json());
    if (img) return img;
    t1 = "Antwort ohne Bild";
  } else t1 = `${r1.status}: ${(await r1.text()).slice(0, 400)}`;

  // 2. Versuch: klassisches generateContent
  const r2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: prompt },
        ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } })),
      ] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect, imageSize: size } },
    }),
  });
  if (r2.ok) {
    const body = await r2.json();
    const img = findImage(body);
    if (img) return img;
    const reason = body?.candidates?.[0]?.finishReason ?? body?.promptFeedback?.blockReason ?? "unbekannt";
    throw new Error(`Gemini hat kein Bild geliefert (Grund: ${reason}).`);
  }
  throw new Error(`Gemini-Fehler. Interactions: ${t1} | generateContent ${r2.status}: ${(await r2.text()).slice(0, 400)}`);
}

const KAT_LABEL: Record<string, string> = {
  wc: "toilet", waschtisch: "washbasin", waschtischarmatur: "basin faucet", duschsystem: "shower system",
  duscharmatur: "shower fittings", duschwanne: "shower tray", duschabtrennung: "shower enclosure",
  badewanne: "bathtub", wannenarmatur: "bath fittings", badmoebel: "vanity unit", spiegel: "mirror", zubehoer: "accessory",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ fehler: "Nur POST" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = req.headers.get("Authorization") ?? "";
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: istTeam, error: teamErr } = await userClient.rpc("bad_ist_team");
    if (teamErr || !istTeam) return json({ fehler: "Kein Zugriff. Bitte mit einem Team-Konto anmelden." }, 403);

    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) return json({ fehler: "Der Gemini-Schlüssel fehlt noch. In Supabase unter Edge Functions → Secrets als GEMINI_API_KEY eintragen." }, 500);

    const { vorher_id, stufe, produkt_ids = [], bausteine = [], wunsch = "", aspect = "4:3", size = "1K" } = await req.json();
    if (!vorher_id) return json({ fehler: "vorher_id fehlt" }, 400);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: vorher, error: vErr } = await admin.from("bad_bilder").select("*").eq("id", vorher_id).single();
    if (vErr || !vorher) return json({ fehler: "Vorher-Foto nicht gefunden" }, 404);

    const { data: foto, error: fErr } = await admin.storage.from("bad-fotos").download(vorher.storage_pfad);
    if (fErr || !foto) return json({ fehler: "Foto konnte nicht geladen werden" }, 500);
    const images: Img[] = [{ mime: foto.type || "image/jpeg", data: toB64(await foto.arrayBuffer()) }];

    const { data: produkte } = produkt_ids.length
      ? await admin.from("bad_produkte").select("*").in("id", produkt_ids)
      : { data: [] as any[] };

    const zeilen: string[] = [];
    for (const p of produkte ?? []) {
      let ref = "";
      if (p.bild_pfad && images.length < 8) {
        const { data: pb } = await admin.storage.from("bad-produktbilder").download(p.bild_pfad);
        if (pb) {
          images.push({ mime: pb.type || "image/jpeg", data: toB64(await pb.arrayBuffer()) });
          ref = ` (reference image #${images.length} shows exactly this product – reproduce its shape and finish faithfully)`;
        }
      }
      zeilen.push(`- ${KAT_LABEL[p.kategorie] ?? p.kategorie}: ${p.bild_beschreibung ?? p.bezeichnung}${ref}`);
    }

    const bauIds = (bausteine as any[]).map((b) => b.id).filter(Boolean);
    const { data: bauDaten } = bauIds.length
      ? await admin.from("bad_bausteine").select("*").in("id", bauIds)
      : { data: [] as any[] };
    const bauZeilen = (bauDaten ?? []).map((b: any) => {
      const menge = Number((bausteine as any[]).find((x) => x.id === b.id)?.menge) || 1;
      return `- ${b.ki_text}${b.einheit === "m" ? ` (about ${menge} m long)` : menge > 1 ? ` (${menge}x)` : ""}`;
    });

    const prompt = [
      "You are a photorealistic bathroom renovation visualizer for a German plumbing company.",
      "Image #1 is a photo of the customer's CURRENT bathroom. Produce the SAME photo after a complete, professional renovation.",
      "STRICT RULES: keep the exact camera position, perspective, lens and framing; keep the room geometry, walls, ceiling height, sloped ceilings, windows (position, size, view), door and radiator positions unless told otherwise.",
      "Place the new sanitary items at the positions where the corresponding old items are, unless the customer wish says otherwise.",
      "Install these products:",
      ...(zeilen.length ? zeilen : ["- modern white sanitary ceramics and chrome fittings"]),
      ...(bauZeilen.length ? ["Construction work (pre-walls built with a dry-construction installation system, all tiled to match):", ...bauZeilen] : []),
      wunsch ? `Customer wishes (German, follow them): ${wunsch}` : "",
      "Finish: new tiles and walls in a calm, contemporary style matching the products, clean grout lines, good natural lighting, no people, no text, no logos, no watermarks.",
      "The result must look like a real photograph of a finished bathroom, not a 3D render.",
    ].filter(Boolean).join("\n");

    const asp = ASPECTS.includes(aspect) ? aspect : "4:3";
    const sz = ["1K", "2K"].includes(size) ? size : "1K";
    const bild = await callGemini(key, prompt, images, asp, sz);

    const ext = bild.mime.includes("png") ? "png" : "jpg";
    const pfad = `${vorher.projekt_id}/nachher-${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await admin.storage.from("bad-fotos").upload(pfad, fromB64(bild.data), { contentType: bild.mime });
    if (upErr) return json({ fehler: "Speichern fehlgeschlagen: " + upErr.message }, 500);

    const { data: zeile, error: insErr } = await admin.from("bad_bilder").insert({
      projekt_id: vorher.projekt_id, art: "nachher", vorher_id, stufe: stufe ?? null,
      storage_pfad: pfad, produkt_ids, bausteine, wunsch,
    }).select().single();
    if (insErr) return json({ fehler: insErr.message }, 500);

    const { data: signed } = await admin.storage.from("bad-fotos").createSignedUrl(pfad, 3600);
    return json({ bild: zeile, url: signed?.signedUrl });
  } catch (e) {
    return json({ fehler: e instanceof Error ? e.message : String(e) }, 500);
  }
});
