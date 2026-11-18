// Perfilar · conexión de la web con el servidor de Render.
// Expone window.claude.use("db") y window.claude.use("sample") con la misma forma que usa la página,
// pero los datos van a /api/db y la IA a /api/ai.
(function () {
  "use strict";

  // ---------- base de datos ----------
  const L = { cols: {}, docs: [], errs: [] };
  let rev = -1, cache = {}, timer = null, failed = 0;

  async function sync() {
    try {
      const r = await fetch("api/sync?rev=" + rev, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      failed = 0;
      if (!j.changed) return;
      rev = j.rev; cache = j.data || {}; emit();
    } catch (e) {
      failed++;
      if (rev < 0 && failed === 2) L.errs.forEach((f) => { try { f({ code: "unavailable", message: String(e) }); } catch (x) {} });
    }
  }
  const snap = (col) => (cache[col] || []).map((d) => ({ id: d.id, exists: true, data: () => d.data, metadata: { fromCache: false, hasPendingWrites: false } }));
  function emit() {
    for (const [col, fns] of Object.entries(L.cols)) {
      const docs = snap(col);
      fns.forEach((f) => f({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} }));
    }
    for (const { col, id, fn } of L.docs) {
      const d = (cache[col] || []).find((x) => x.id === id);
      fn({ id, exists: !!d, data: () => (d ? d.data : undefined), metadata: {} });
    }
  }
  function start() { if (!timer) { sync(); timer = setInterval(sync, 3000); } }
  async function call(method, col, id, body) {
    let r;
    try {
      r = await fetch("api/db/" + encodeURIComponent(col) + "/" + encodeURIComponent(id), {
        method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw { code: "unavailable", message: String(e) }; }
    if (!r.ok) throw { code: r.status === 400 ? "invalid_argument" : "unavailable", message: await r.text() };
    await sync();
  }
  const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  function docRef(col, id) {
    return {
      id, path: col + "/" + id,
      set: (d) => call("PUT", col, id, d),
      update: (d) => call("PATCH", col, id, d),
      delete: () => call("DELETE", col, id),
      get: async () => { await sync(); const d = (cache[col] || []).find((x) => x.id === id); return { id, exists: !!d, data: () => d && d.data, metadata: {} }; },
      onSnapshot(fn, err) {
        const e = { col, id, fn }; L.docs.push(e); if (err) L.errs.push(err); start();
        if (rev >= 0) setTimeout(emit, 0);
        return () => { L.docs = L.docs.filter((x) => x !== e); };
      },
    };
  }
  const db = {
    collection(col) {
      return {
        path: col,
        doc: (id) => docRef(col, id || rid()),
        onSnapshot(fn, err) {
          (L.cols[col] = L.cols[col] || []).push(fn); if (err) L.errs.push(err); start();
          if (rev >= 0) setTimeout(emit, 0);
          return () => { L.cols[col] = L.cols[col].filter((f) => f !== fn); };
        },
      };
    },
    doc(p) { const [c, i] = p.split("/"); return docRef(c, i); },
  };

  // ---------- IA ----------
  function parseJSON(t) {
    try { return JSON.parse(t); } catch (e) {}
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    const a = Math.min(...["{", "["].map((c) => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
    const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a < b) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    throw { code: "invalid_json", message: "La respuesta no es JSON", text: t };
  }
  // Achica fotos grandes antes de mandarlas (lado mayor 2000 px, JPEG)
  async function toBase64(blob) {
    let type = blob.type || "image/jpeg", outBlob = blob;
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      if (scale < 1 || blob.size > 4e6 || !/^image\/(jpeg|png|webp|gif)$/.test(type)) {
        const c = document.createElement("canvas");
        c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
        const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        outBlob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.88)); type = "image/jpeg";
      }
    } catch (e) {}
    const buf = new Uint8Array(await outBlob.arrayBuffer());
    let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { type, data: btoa(bin) };
  }
  async function ask(input, opts, json) {
    opts = opts || {};
    if (opts.signal && opts.signal.aborted) throw { code: "cancelled", message: "cancelled" };
    const list = !opts.images ? [] : opts.images instanceof Blob ? [opts.images] : Array.from(opts.images);
    const images = [];
    for (const b of list.slice(0, 5)) images.push(await toBase64(b));
    let r;
    try {
      r = await fetch("api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, json, images }), signal: opts.signal });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled", message: "cancelled" };
      throw { code: "upstream_error", message: String(e) };
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: j.code || "upstream_error", message: j.message || "HTTP " + r.status };
    if (opts.onText) { try { opts.onText({ text: j.text, delta: j.text }); } catch (e) {} }
    return j;
  }
  const sample = async (input, opts) => { const j = await ask(input, opts, false); return { text: j.text, truncated: !!j.truncated, modelTierApplied: "default" }; };
  sample.json = async (input, opts) => parseJSON((await ask(input, opts, true)).text);
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 3, maxInputBytes: 30e6, mediaTypes: ["image/jpeg", "image/png", "image/webp"] } });

  const cfg = fetch("api/config", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ ai: false }));
  window.claude = {
    use: async (name) => {
      if (name === "db") return db;
      if (name === "sample") return (await cfg).ai ? sample : null;
      return null;
    },
  };
})();
