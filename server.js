// Perfilar · servidor para Render
// Sirve la web, guarda los datos (Postgres o archivo local) y hace de puente con la IA (Google Gemini gratis, o Anthropic).
const express = require("express");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = (process.env.GEMINI_API_KEY || "").trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
// Si hay clave de Gemini se usa Gemini (tiene plan gratis); si no, Anthropic.
const PROVIDER = GEMINI_KEY ? "gemini" : ANTHROPIC_KEY ? "anthropic" : "";
const KEY = GEMINI_KEY || ANTHROPIC_KEY;
const MODEL = PROVIDER === "gemini" ? (process.env.GEMINI_MODEL || "gemini-3.1-flash-lite") : (process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5");
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
const PASS = process.env.APP_PASSWORD || "";
const API_BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
let DB_KIND = "archivo";
const COLS = ["puestos", "candidatos", "evals", "pipeline", "config"];
const SAFE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

const app = express();
app.use(express.json({ limit: "30mb" }));

// Contraseña opcional para toda la app (usuario: cualquiera, contraseña: APP_PASSWORD)
if (PASS) {
  app.use((req, res, next) => {
    const [type, value] = (req.headers.authorization || "").split(" ");
    if (type === "Basic" && value) {
      const pass = Buffer.from(value, "base64").toString().split(":").slice(1).join(":");
      if (pass === PASS) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Perfilar"').status(401).send("Acceso restringido");
  });
}

// ---------- almacenamiento ----------
let store;
let rev = Date.now();

async function pgStore(url) {
  const { Pool } = require("pg");
  for (const ssl of [{ rejectUnauthorized: false }, false]) {
    const pool = new Pool({ connectionString: url, ssl });
    try {
      await pool.query("select 1");
      await pool.query(`create table if not exists docs (
        col text not null, id text not null, data jsonb not null,
        updated timestamptz not null default now(), primary key (col, id))`);
      console.log(`Base de datos Postgres conectada (ssl: ${ssl ? "sí" : "no"})`);
      DB_KIND = "postgres";
      return {
        all: async () => (await pool.query("select col, id, data from docs order by col, id")).rows,
        get: async (col, id) => {
          const r = await pool.query("select data from docs where col=$1 and id=$2", [col, id]);
          return r.rows[0] ? r.rows[0].data : null;
        },
        set: (col, id, data) => pool.query(
          "insert into docs (col, id, data) values ($1,$2,$3) on conflict (col, id) do update set data = excluded.data, updated = now()",
          [col, id, JSON.stringify(data)]),
        del: (col, id) => pool.query("delete from docs where col=$1 and id=$2", [col, id]),
      };
    } catch (e) {
      await pool.end().catch(() => {});
      if (ssl === false) throw e;
    }
  }
}

function fileStore() {
  const file = path.join(__dirname, "data.json");
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  const save = () => fs.writeFileSync(file, JSON.stringify(db));
  console.log("Sin DATABASE_URL: los datos se guardan en data.json (en Render se borran al reiniciar).");
  return {
    all: async () => Object.entries(db).flatMap(([col, docs]) => Object.entries(docs).map(([id, data]) => ({ col, id, data }))),
    get: async (col, id) => (db[col] && db[col][id]) || null,
    set: async (col, id, data) => { (db[col] = db[col] || {})[id] = data; save(); },
    del: async (col, id) => { if (db[col]) delete db[col][id]; save(); },
  };
}

async function seedIfEmpty() {
  const rows = await store.all();
  if (rows.length) return;
  const seedFile = path.join(__dirname, "seed.json");
  if (!fs.existsSync(seedFile)) return;
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  for (const [col, docs] of Object.entries(seed)) for (const [id, data] of Object.entries(docs)) await store.set(col, id, data);
  console.log("Base vacía: se cargaron las vacantes iniciales de seed.json.");
}

// ---------- API de datos ----------
const valid = (col, id) => COLS.includes(col) && SAFE.test(id);

app.get("/api/config", (req, res) => res.json({ ai: !!KEY, provider: PROVIDER, model: MODEL }));

app.get("/api/sync", async (req, res) => {
  try {
    if (String(req.query.rev) === String(rev)) return res.json({ changed: false, rev });
    const data = {};
    for (const c of COLS) data[c] = [];
    for (const r of await store.all()) if (data[r.col]) data[r.col].push({ id: r.id, data: r.data });
    res.json({ changed: true, rev, data });
  } catch (e) { console.error(e); res.status(500).json({ message: "Error de base de datos" }); }
});

app.put("/api/db/:col/:id", async (req, res) => {
  const { col, id } = req.params;
  if (!valid(col, id) || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).send("Datos inválidos");
  try { await store.set(col, id, req.body); rev++; res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).send("Error de base de datos"); }
});

app.patch("/api/db/:col/:id", async (req, res) => {
  const { col, id } = req.params;
  if (!valid(col, id) || !req.body || typeof req.body !== "object") return res.status(400).send("Datos inválidos");
  try {
    const prev = await store.get(col, id);
    if (!prev) return res.status(400).send("El documento no existe");
    await store.set(col, id, Object.assign({}, prev, req.body)); rev++; res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).send("Error de base de datos"); }
});

app.delete("/api/db/:col/:id", async (req, res) => {
  const { col, id } = req.params;
  if (!valid(col, id)) return res.status(400).send("Datos inválidos");
  try { await store.del(col, id); rev++; res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).send("Error de base de datos"); }
});

// ---------- IA ----------
// Devuelve {ok:true,text,truncated} o {ok:false,status,code,message}
async function callAI(text, images, json, maxTokens) {
  if (PROVIDER === "gemini") return callGemini(text, images, json, maxTokens);
  return callAnthropic(text, images, json, maxTokens);
}

async function callGemini(text, images, json, maxTokens) {
  const parts = [];
  images.forEach((im, i) => {
    if (images.length > 1) parts.push({ text: `Página ${i + 1}:` });
    parts.push({ inline_data: { mime_type: im.type, data: im.data } });
  });
  parts.push({ text });
  const body = { contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: maxTokens } };
  if (json) body.generationConfig.responseMimeType = "application/json";
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  let r, j;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    j = await r.json().catch(() => ({}));
  } catch (e) { return { ok: false, status: 0, code: "upstream_error", message: "No se pudo contactar a Gemini: " + e.message }; }
  if (!r.ok) {
    const msg = (j.error && j.error.message) || "";
    console.error("Error de Gemini:", r.status, msg);
    if (/API key not valid|API_KEY_INVALID|permission|unauthenticated/i.test(msg) || r.status === 401 || r.status === 403)
      return { ok: false, status: r.status, code: "bad_key", message: "La clave GEMINI_API_KEY no es válida. Creá una nueva en aistudio.google.com y pegala en Render → Environment." };
    if (r.status === 429)
      return { ok: false, status: r.status, code: "rate_limited", message: "Se alcanzó el límite gratis de Gemini. Esperá un minuto; si sigue, el cupo diario se renueva al otro día." };
    if (r.status === 404 || /model/i.test(msg))
      return { ok: false, status: r.status, code: "bad_model", message: "El modelo " + MODEL + " no está disponible en Gemini. Cambiá GEMINI_MODEL en Render por uno que figure en aistudio.google.com." };
    if (/location|region|not supported/i.test(msg))
      return { ok: false, status: r.status, code: "upstream_error", message: "Gemini no está disponible desde esta región: " + msg };
    return { ok: false, status: r.status, code: "upstream_error", message: "Gemini devolvió un error (" + r.status + "): " + msg };
  }
  const cand = (j.candidates || [])[0];
  if (!cand) {
    const why = j.promptFeedback && j.promptFeedback.blockReason;
    return { ok: false, status: 200, code: why ? "refused" : "empty_completion", message: why ? "Gemini bloqueó el contenido (" + why + ")." : "Gemini no devolvió respuesta." };
  }
  const out = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!out.trim()) return { ok: false, status: 200, code: cand.finishReason === "SAFETY" ? "refused" : "empty_completion", message: "Gemini no devolvió texto (" + (cand.finishReason || "sin motivo") + ")." };
  return { ok: true, text: out, truncated: cand.finishReason === "MAX_TOKENS" };
}

async function callAnthropic(text, images, json, maxTokens) {
  const content = [];
  images.forEach((im, i) => {
    if (images.length > 1) content.push({ type: "text", text: `Página ${i + 1}:` });
    content.push({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } });
  });
  content.push({ type: "text", text });
  const body = { model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] };
  if (json) body.system = "Respondé únicamente con JSON válido, sin texto antes ni después y sin bloques de código.";
  let r, j;
  try {
    r = await fetch(API_BASE + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    j = await r.json().catch(() => ({}));
  } catch (e) { return { ok: false, status: 0, code: "upstream_error", message: "No se pudo contactar a Anthropic: " + e.message }; }
  if (!r.ok) {
    const msg = (j.error && j.error.message) || "";
    console.error("Error de Anthropic:", r.status, msg);
    if (r.status === 401) return { ok: false, status: 401, code: "bad_key", message: "La clave ANTHROPIC_API_KEY no es válida. Revisala en Render → Environment." };
    if (/credit balance/i.test(msg)) return { ok: false, status: r.status, code: "no_credit", message: "La cuenta de Anthropic no tiene crédito. Podés usar Gemini gratis: agregá GEMINI_API_KEY en Render." };
    if (r.status === 404 || /model/i.test(msg)) return { ok: false, status: r.status, code: "bad_model", message: "El modelo configurado no existe: " + MODEL + "." };
    if (r.status === 429 || r.status === 529) return { ok: false, status: r.status, code: "rate_limited", message: "La IA está saturada o se alcanzó el límite. Probá de nuevo en un minuto." };
    return { ok: false, status: r.status, code: "upstream_error", message: "La IA devolvió un error (" + r.status + "): " + msg };
  }
  const out = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!out.trim()) return { ok: false, status: 200, code: j.stop_reason === "refusal" ? "refused" : "empty_completion", message: "La IA no devolvió texto." };
  return { ok: true, text: out, truncated: j.stop_reason === "max_tokens" };
}

app.post("/api/ai", async (req, res) => {
  if (!KEY) return res.status(503).json({ code: "sampling_disabled", message: "Falta configurar GEMINI_API_KEY en Render." });
  const { input, json, images = [] } = req.body || {};
  const text = typeof input === "string" ? input : Array.isArray(input) ? input.map((m) => m.content).join("\n\n") : "";
  if (!text) return res.status(400).json({ code: "invalid_request", message: "Falta el texto." });
  const out = await callAI(text, images.slice(0, 5), !!json, 8000);
  if (!out.ok) return res.status(502).json({ code: out.code, message: out.message });
  res.json({ text: out.text, truncated: out.truncated });
});

// Diagnóstico: abrir /diagnostico para ver qué está mal configurado
app.get("/api/diag", async (req, res) => {
  const out = { servidor: true, baseDeDatos: DB_KIND, claveIA: !!KEY, proveedor: PROVIDER || "ninguno", modelo: MODEL, pruebaIA: null };
  try { out.registros = (await store.all()).length; } catch (e) { out.baseDeDatos = "error: " + e.message; }
  if (KEY) {
    const r = await callAI("Respondé solo con la palabra OK.", [], false, 256);
    out.pruebaIA = r.ok ? "OK" : r.message;
  }
  res.json(out);
});
app.get("/diagnostico", (req, res) => res.sendFile(path.join(__dirname, "public", "diagnostico.html")));

app.use(express.static(path.join(__dirname, "public")));

(async () => {
  store = process.env.DATABASE_URL ? await pgStore(process.env.DATABASE_URL) : fileStore();
  await seedIfEmpty();
  app.listen(PORT, () => console.log(`Perfilar escuchando en el puerto ${PORT} · IA: ${KEY ? PROVIDER + " / " + MODEL : "sin clave"}`));
})().catch((e) => { console.error("No se pudo iniciar:", e); process.exit(1); });
