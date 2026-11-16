"use strict";
/* Upcruit Hiring Pulse — standalone server.
   One Node process: serves the screens in /public and a small JSON API backed by SQLite. */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const multer = require("multer");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const QRCode = require("qrcode");
const Q = require("@upcruit/questions");

const PORT = Number(process.env.PORT) || 3000;
/* Default to the database folder at the repo root (Docker sets DATA_DIR=/data). */
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "..", "..", "data");
const STAFF_PIN = (process.env.STAFF_PIN || "").trim();
const MAX_SUBMITS_PER_MIN = Number(process.env.MAX_SUBMITS_PER_MIN) || 60;

/* ---------- Database ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "pulse.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS responses (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS responses_at ON responses(at);
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const getConfig = (k, d) => { const r = db.prepare("SELECT value FROM config WHERE key=?").get(k); return r ? JSON.parse(r.value) : d; };
const setConfig = (k, v) => db.prepare("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, JSON.stringify(v));

/* ---------- Validation ---------- */
const ids = list => new Set(list.map(x => x.id));
const SET = { SKILLS: ids(Q.SKILLS), EXP: ids(Q.EXP), ROLES: ids(Q.ROLES), PAIN: ids(Q.PAIN) };
function validate(body) {
  if (!body || (body.t !== "c" && body.t !== "h")) return { error: "That answer wasn't complete. Please start over." };
  const out = { t: body.t };
  for (const step of Q.FLOWS[body.t]) {
    if (step.type === "contact") {
      const c = body.contact || {};
      const name = Q.normName(c.name), email = Q.normEmail(c.email), phone = Q.normPhone(c.phone);
      if (!name) return { error: "Please enter your name." };
      if (!email) return { error: "Please check your email address." };
      if (!phone) return { error: "Please check your mobile number (10 digits, or with a country code)." };
      if (c.consent !== true) return { error: "Please tick the consent box so we can contact you about jobs." };
      out.contact = { name, email, phone };
      out.showName = c.showName === true;
      continue;
    }
    const allowed = SET[step.opts];
    let v = body[step.key];
    if (step.optional && (v == null || v === "")) continue;
    if (step.multi > 1) {
      if (!Array.isArray(v)) return { error: "That answer wasn't complete. Please start over." };
      v = [...new Set(v)].filter(x => typeof x === "string" && allowed.has(x));
      if (v.length < 1 || v.length > step.multi) return { error: "That answer wasn't complete. Please start over." };
    } else if (typeof v !== "string" || !allowed.has(v)) return { error: "That answer wasn't complete. Please start over." };
    out[step.key] = v;
  }
  return { value: out };
}
const publicName = n => { const p = String(n).split(" ").filter(Boolean); return p[0] + (p.length > 1 ? " " + p[p.length - 1][0].toUpperCase() + "." : ""); };

/* ---------- Jobs: import + matching ---------- */
const norm = s => String(s == null ? "" : s).toLowerCase().replace(/\*/g, "").replace(/[‐‑–—]/g, "-").replace(/\s+/g, " ").trim();
const SKILL_BY_LABEL = new Map(Q.SKILLS.flatMap(s => [[norm(s.label), s.id], [norm(s.short), s.id], [s.id, s.id]]));
const ROLE_BY_LABEL = new Map(Q.ROLES.flatMap(r => [[norm(r.label), r.id], [norm(r.short), r.id], [r.id, r.id]]));
const HEADERS = {
  id: h => h === "job id", title: h => h === "job title", company: h => h === "company",
  role: h => h.startsWith("role category"), s1: h => h === "skill 1", s2: h => h === "skill 2", s3: h => h === "skill 3",
  tools: h => h.startsWith("key tools"), minExp: h => h.startsWith("min experience"), maxExp: h => h.startsWith("max experience"),
  fresher: h => h.startsWith("fresher"), location: h => h === "location", mode: h => h === "work mode",
  salary: h => h.startsWith("salary"), link: h => h.startsWith("apply link"), active: h => h.startsWith("active")
};
const REQUIRED = ["id", "title", "company", "s1", "link"];
const yes = v => ["yes", "y", "true", "1"].includes(norm(v));

function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.hyperlink && typeof v.hyperlink === "string" && /^https?:/i.test(v.hyperlink)) return v.hyperlink;
    if (v.richText) return v.richText.map(t => t.text).join("");
    if (v.text != null) return typeof v.text === "object" && v.text.richText ? v.text.richText.map(t => t.text).join("") : String(v.text);
    if (v.result != null) return String(v.result);
    return "";
  }
  return String(v).trim();
}
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
/* Cell comments (the template's header tips) aren't needed and trip up ExcelJS's reader, so drop them first. */
async function stripComments(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    zip.forEach(p => { if (/^xl\/comments[^/]*\.xml$/i.test(p) || /^xl\/drawings\/vmlDrawing[^/]*\.vml$/i.test(p) || /^xl\/threadedComments\//i.test(p) || /^xl\/persons\//i.test(p)) zip.remove(p); });
    for (const p of Object.keys(zip.files)) {
      if (/^xl\/worksheets\/_rels\/.*\.rels$/i.test(p)) {
        const x = await zip.file(p).async("string");
        zip.file(p, x.replace(/<Relationship\b[^>]*Type="[^"]*\/(comments|vmlDrawing|threadedComment)"[^>]*\/>/gi, ""));
      } else if (/^xl\/worksheets\/[^/]*\.xml$/i.test(p)) {
        const x = await zip.file(p).async("string");
        zip.file(p, x.replace(/<legacyDrawing\b[^>]*\/>/gi, ""));
      } else if (p === "[Content_Types].xml") {
        const x = await zip.file(p).async("string");
        zip.file(p, x.replace(/<Override\b[^>]*PartName="\/xl\/(comments|threadedComments|persons)[^"]*"[^>]*\/>/gi, ""));
      }
    }
    return await zip.generateAsync({ type: "nodebuffer" });
  } catch { return buffer; }
}
async function readRows(file) {
  const name = (file.originalname || "").toLowerCase();
  if (name.endsWith(".csv")) return parseCsv(file.buffer.toString("utf8"));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await stripComments(file.buffer));
  const ws = wb.getWorksheet("Jobs") || wb.worksheets.find(w => /job/i.test(w.name)) || wb.worksheets[0];
  if (!ws) throw new Error("The file has no sheets.");
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    const vals = [];
    for (let c = 1; c <= Math.max(r.cellCount, 16); c++) vals.push(cellText(r.getCell(c).value));
    rows[n - 1] = vals;
  });
  return rows.map(r => r || []);
}
function rowsToJobs(rows) {
  const headerIdx = rows.findIndex(r => r && r.some(c => norm(c) === "job id"));
  if (headerIdx < 0) throw new Error("Couldn't find the header row. Keep the template's column names (starting with \"Job ID\").");
  const header = rows[headerIdx].map(norm);
  const col = {};
  for (const [k, test] of Object.entries(HEADERS)) { const i = header.findIndex(test); if (i >= 0) col[k] = i; }
  const missing = REQUIRED.filter(k => col[k] == null);
  if (missing.length) throw new Error("Missing columns: " + missing.join(", ") + ". Use the provided template.");
  const jobs = [], warnings = [], seen = new Set();
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const line = headerIdx + i + 2;
    const g = k => (col[k] == null ? "" : String(r[col[k]] == null ? "" : r[col[k]]).trim());
    const id = g("id"), title = g("title");
    if (!id && !title) return;
    if (/^example/i.test(id)) return;
    if (!id || !title || !g("company")) { warnings.push(`Row ${line}: skipped, Job ID, Job title and Company are required.`); return; }
    if (seen.has(id)) { warnings.push(`Row ${line}: skipped, duplicate Job ID ${id}.`); return; }
    const skills = [];
    for (const k of ["s1", "s2", "s3"]) {
      const v = g(k); if (!v) continue;
      const sid = SKILL_BY_LABEL.get(norm(v));
      if (sid) { if (!skills.includes(sid)) skills.push(sid); } else warnings.push(`Row ${line}: skill "${v}" isn't in the list, ignored.`);
    }
    if (!skills.length) { warnings.push(`Row ${line}: skipped, needs at least one skill from the list.`); return; }
    let link = g("link");
    if (!/^https?:\/\/\S+$/i.test(link)) { warnings.push(`Row ${line}: skipped, Apply link must start with https://`); return; }
    const role = ROLE_BY_LABEL.get(norm(g("role"))) || "";
    const minExp = parseInt(g("minExp"), 10), maxExp = parseInt(g("maxExp"), 10);
    const activeRaw = g("active");
    const job = {
      id, title, company: g("company"), role, skills, tools: g("tools"),
      minExp: Number.isFinite(minExp) ? minExp : null, maxExp: Number.isFinite(maxExp) ? maxExp : null,
      fresher: yes(g("fresher")) || minExp === 0, location: g("location"), mode: g("mode"), salary: g("salary"),
      link, active: activeRaw === "" ? true : yes(activeRaw)
    };
    seen.add(id); jobs.push(job);
  });
  return { jobs, warnings };
}
function allJobs() { return db.prepare("SELECT data FROM jobs").all().map(r => JSON.parse(r.data)); }
function expFits(j, band) {
  if (!band) return true;
  if (band.id === "f") return j.fresher || j.minExp === 0;
  return (j.minExp == null || j.minExp <= band.max) && (j.maxExp == null || j.maxExp >= band.min);
}
function matchJobs(resp, limit = 3) {
  const have = new Set(resp.have || []);
  const band = Q.EXP.find(e => e.id === resp.exp);
  const fresher = band && band.id === "f";
  return allJobs()
    .filter(j => j.active && expFits(j, band))
    .map(j => {
      let s = 0;
      j.skills.forEach((k, i) => { if (have.has(k)) s += i === 0 ? 3 : 2; else if (k === resp.train) s += 1; });
      return { j, s };
    })
    .filter(x => x.s > 0 || fresher)
    .sort((a, b) => b.s - a.s || (a.j.minExp ?? 99) - (b.j.minExp ?? 99) || a.j.title.localeCompare(b.j.title))
    .slice(0, limit)
    .map(({ j }) => ({ id: j.id, title: j.title, company: j.company, location: j.location, mode: j.mode, salary: j.salary, tools: j.tools, minExp: j.minExp, maxExp: j.maxExp, fresher: j.fresher, link: j.link, skills: j.skills }));
}

/* ---------- App ---------- */
const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); res.set("Referrer-Policy", "same-origin"); next(); });
/* The screens load the shared question bank as a plain script (window.PULSE_Q). */
const QUESTIONS_JS = require.resolve("@upcruit/questions");
app.get("/questions.js", (req, res) => res.sendFile(QUESTIONS_JS));
app.use(express.static(path.resolve(__dirname, "..", "..", "web", "public"), { extensions: ["html"], maxAge: "5m" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

/* What the screens may see: no email or phone, and a name only when the person opted in. One row per email (latest). */
function publicRows(raw) {
  const seen = new Set(), out = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    const r = raw[i], d = JSON.parse(r.data);
    if (r.t === "c") {
      const key = d.contact && d.contact.email;
      if (key) { if (seen.has(key)) continue; seen.add(key); }
      out.push({ t: "c", at: r.at, exp: d.exp, have: d.have, train: d.train, matched: d.matched || 0,
        top: d.top || null, name: d.showName && d.contact ? publicName(d.contact.name) : null });
    } else out.push({ t: "h", at: r.at, roles: d.roles, need: d.need, pain: d.pain });
  }
  return out.reverse();
}
app.get("/api/data", (req, res) => {
  const since = getConfig("since", 0);
  const rows = publicRows(db.prepare("SELECT t, data, at FROM responses WHERE at >= ? ORDER BY at").all(since));
  const jobsActive = allJobs().filter(j => j.active).length;
  res.set("Cache-Control", "no-store").json({ since, responses: rows, jobsActive, serverTime: Date.now() });
});

const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
app.post("/api/responses", (req, res) => {
  const ip = req.ip || "x"; const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
  if (n > MAX_SUBMITS_PER_MIN) return res.status(429).json({ error: "Too many answers from this device. Please wait a minute." });
  const r = validate(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  const v = r.value;
  const at = Date.now();
  const { t, ...data } = v;
  const matches = t === "c" ? matchJobs(v) : [];
  if (t === "c") {
    data.matched = matches.length;
    data.jobs = matches.map(m => m.id);
    data.jobTitles = matches.map(m => `${m.title} (${m.company})`);
    data.top = matches[0] ? { title: matches[0].title, company: matches[0].company } : null;
  }
  db.prepare("INSERT INTO responses(t,data,at) VALUES(?,?,?)").run(t, JSON.stringify(data), at);
  res.json({ ok: true, matches, firstName: t === "c" ? v.contact.name.split(" ")[0] : null });
});

app.get("/api/qr", async (req, res) => {
  const text = String(req.query.text || "");
  if (!text || text.length > 600) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0E1626", light: "#FFFFFF" } });
    res.set("Content-Type", "image/svg+xml").set("Cache-Control", "public, max-age=86400").send(svg);
  } catch { res.status(400).end(); }
});

/* ---------- Staff ---------- */
function staff(req, res, next) {
  if (!STAFF_PIN) return res.status(503).json({ error: "Staff desk is off. Set STAFF_PIN on the server to turn it on." });
  const given = String(req.get("x-staff-pin") || req.query.pin || "");
  const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(STAFF_PIN).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Wrong PIN." });
  next();
}
app.post("/api/staff/login", staff, (req, res) => res.json({ ok: true }));
app.post("/api/staff/clear", staff, (req, res) => { const since = Date.now(); setConfig("since", since); res.json({ ok: true, since }); });
app.post("/api/staff/unclear", staff, (req, res) => { setConfig("since", 0); res.json({ ok: true }); });
app.get("/api/staff/jobs", staff, (req, res) => res.json({ jobs: allJobs(), updatedAt: getConfig("jobsUpdatedAt", null), fileName: getConfig("jobsFile", null) }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.post("/api/staff/jobs", staff, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose an .xlsx or .csv file first." });
  try {
    const { jobs, warnings } = rowsToJobs(await readRows(req.file));
    if (!jobs.length) return res.status(400).json({ error: "No jobs found in the file. Fill rows from row 3 of the Jobs sheet.", warnings });
    db.transaction(() => {
      db.prepare("DELETE FROM jobs").run();
      const ins = db.prepare("INSERT INTO jobs(id,data) VALUES(?,?)");
      jobs.forEach(j => ins.run(j.id, JSON.stringify(j)));
    })();
    setConfig("jobsUpdatedAt", Date.now()); setConfig("jobsFile", req.file.originalname || "");
    res.json({ ok: true, total: jobs.length, active: jobs.filter(j => j.active).length, warnings });
  } catch (e) {
    res.status(400).json({ error: e && e.message ? e.message : "Couldn't read that file. Use the .xlsx template or a .csv export of it." });
  }
});

const labelOf = (list, id) => (Q[list].find(x => x.id === id) || {}).label || id;
const joinLabels = (list, v) => (Array.isArray(v) ? v : [v]).filter(Boolean).map(x => labelOf(list, x)).join("; ");
app.get("/api/staff/candidates", staff, (req, res) => {
  const rows = db.prepare("SELECT data, at FROM responses WHERE t='c' ORDER BY at DESC LIMIT 100").all().map(r => {
    const d = JSON.parse(r.data), c = d.contact || {};
    return { at: r.at, name: c.name || "", email: c.email || "", phone: c.phone || "", exp: labelOf("EXP", d.exp),
      skills: joinLabels("SKILLS", d.have), matched: d.matched || 0, jobs: (d.jobTitles || []).join("; ") };
  });
  res.json({ candidates: rows });
});
app.get("/api/staff/export.csv", staff, (req, res) => {
  const esc = s => { s = String(s == null ? "" : s); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const head = ["time (IST)", "type", "name", "email", "phone", "experience", "skills", "training in", "jobs matched", "matched jobs", "matched job IDs", "name on screen", "hiring roles", "hard-to-find skills", "pain points"];
  const lines = [head.map(esc).join(",")];
  const PHONE = "\u0000phone:"; /* marker: phones are written as ="+91…" so Excel keeps them as text */
  const ist = ms => new Date(ms + 5.5 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
  db.prepare("SELECT t,data,at FROM responses ORDER BY at").all().forEach(r => {
    const d = JSON.parse(r.data), c = d.contact || {}, isC = r.t === "c";
    lines.push([ist(r.at), isC ? "job seeker" : "HR leader", c.name, c.email, PHONE + (c.phone || ""), isC ? labelOf("EXP", d.exp) : "",
      joinLabels("SKILLS", d.have), joinLabels("SKILLS", d.train), isC ? (d.matched || 0) : "", (d.jobTitles || []).join("; "), (d.jobs || []).join("; "),
      isC ? (d.showName ? "yes" : "no") : "", joinLabels("ROLES", d.roles), joinLabels("SKILLS", d.need), joinLabels("PAIN", d.pain)]
      .map(v => typeof v === "string" && v.startsWith(PHONE) ? (/^\+\d{8,15}$/.test(v.slice(PHONE.length)) ? `"=""${v.slice(PHONE.length)}"""` : '""') : esc(v)).join(","));
  });
  res.set("Content-Type", "text/csv; charset=utf-8").set("Cache-Control", "no-store").set("Content-Disposition", 'attachment; filename="hiring-pulse-answers.csv"').send("\uFEFF" + lines.join("\r\n"));
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Something went wrong on the server." }); });

app.listen(PORT, () => {
  console.log(`Hiring Pulse running on http://localhost:${PORT}`);
  if (!STAFF_PIN) console.warn("STAFF_PIN is not set: the staff desk (job upload, clear, export) is disabled.");
});
