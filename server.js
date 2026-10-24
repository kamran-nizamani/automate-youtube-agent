require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { renderVideo } = require("./render");

const app = express();
const PORT = Number(process.env.PORT || 3456);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "projects.json");
const RENDERS_DIR = path.join(DATA_DIR, "renders");

app.use(express.json({ limit: "1mb" }));
app.use("/outputs", express.static(RENDERS_DIR, { fallthrough: false, dotfiles: "deny", index: false }));
app.use(express.static(path.join(__dirname, "public")));

async function readProjects() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeProjects(projects) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(projects, null, 2) + "\n", "utf8");
}

function clean(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength || 300);
}

function makeDemoScript(input) {
  const sections = [
    { heading: "The big idea", narration: input.topic + " matters because it helps us understand " + (input.niche || "this subject") + ". Start with the basic idea and avoid complicated assumptions." },
    { heading: "What you should know", narration: "Look at the evidence, compare examples, and separate confirmed facts from opinions. Break the topic into smaller steps and consider how each step works in real life." },
    { heading: "A practical example", narration: "Imagine explaining " + input.topic + " to a friend who is new to it. Start with one simple example, explain why it matters, and show what the example teaches us." },
    { heading: "Takeaway", narration: "We introduced " + input.topic + ", explained the main idea, and explored a practical example. Verify specific claims and add reliable sources before publishing." }
  ];
  const intro = "Have you ever wondered about " + input.topic + "? In this video, we will break it down in a clear and practical way.";
  return {
    title: input.topic + ": A Simple Guide",
    hook: intro,
    narration: [intro].concat(sections.map(function (s) { return s.heading + ". " + s.narration; })).join("\n\n"),
    scenes: sections.map(function (s, i) { return { scene: i + 1, heading: s.heading, visual: "Suggested visual for " + input.topic + ": " + s.heading, narration: s.narration }; }),
    description: "In this video, we explore " + input.topic + " in the " + (input.niche || "education") + " niche. This is a first draft; fact-check it before publishing.\n\nChapters:\n00:00 Introduction\n00:30 The big idea\n01:15 What you should know\n02:00 Practical example\n02:45 Takeaway",
    tags: [input.topic, input.niche || "education", "explained", "beginner guide", "learning"],
    estimatedWordCount: Math.max(120, input.duration * 130),
    tone: input.tone,
    durationMinutes: input.duration,
    generator: "local-demo",
    note: "Demo draft: add GEMINI_API_KEY to .env to enable AI script generation. Verify facts before publishing."
  };
}

async function generateWithGemini(input) {
  if (!process.env.GEMINI_API_KEY) return makeDemoScript(input);
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(process.env.GEMINI_API_KEY);
  const prompt = "You are a careful YouTube script-writing assistant. Return ONLY valid JSON with keys: title, hook, narration, scenes (array of objects with scene, heading, visual, narration), description, tags (array), estimatedWordCount, tone, durationMinutes, generator, note. Topic: " + input.topic + ". Niche: " + (input.niche || "general") + ". Tone: " + input.tone + ". Target duration: " + input.duration + " minutes. Include an engaging honest hook, intro, 3-5 useful sections, recap, and scene suggestions. Do not invent statistics or citations. Mark claims needing verification.";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.7 } }),\n    signal: AbortSignal.timeout(45000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload && payload.error ? payload.error.message : "Gemini request failed (" + response.status + ")");
  const text = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content && Array.isArray(payload.candidates[0].content.parts) ? payload.candidates[0].content.parts.map(function (p) { return p.text || ""; }).join("") : "";
  if (!text) throw new Error("Gemini returned an empty response.");
  return Object.assign(JSON.parse(text), { generator: "gemini", note: "AI-generated first draft. Verify factual claims and sources before publishing." });
}

app.get("/api/health", function (_req, res) {
  res.json({ ok: true, app: "YouTube AI Automation Agent", milestone: 2, aiConfigured: Boolean(process.env.GEMINI_API_KEY), videoRendering: true, platform: process.platform });
});

app.get("/api/projects", async function (_req, res, next) {
  try {
    const projects = await readProjects();
    res.json(projects.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }));
  } catch (error) { next(error); }
});

app.post("/api/generate", async function (req, res) {
  try {
    const input = {
      topic: clean(req.body.topic, 180),
      niche: clean(req.body.niche, 80),
      tone: clean(req.body.tone || "Clear and engaging", 80),
      duration: Math.max(1, Math.min(20, Number(req.body.duration) || 3))
    };
    if (input.topic.length < 3) return res.status(400).json({ error: "Please enter a topic with at least 3 characters." });
    res.json(Object.assign(await generateWithGemini(input), { input: input }));
  } catch (error) {
    console.error("Script generation failed:", error.message);
    res.status(502).json({ error: "Could not generate a script: " + error.message });
  }
});

app.post("/api/render", async function (req, res) {
  try {
    const draft = req.body && req.body.draft;
    if (!draft || typeof draft.narration !== "string") {
      return res.status(400).json({ error: "Generate a script before rendering a video." });
    }
    const id = crypto.randomUUID();
    const outputDir = path.join(RENDERS_DIR, id);
    const result = await renderVideo(draft, outputDir);
    res.status(201).json(Object.assign({ id: id, title: clean(draft.title, 180) || "Untitled video" }, result));
  } catch (error) {
    console.error("Video rendering failed:", error.message);
    res.status(500).json({ error: "Video rendering failed: " + error.message });
  }
});

app.post("/api/projects", async function (req, res, next) {
  try {
    const title = clean(req.body.title, 180);
    const topic = clean(req.body.topic, 180);
    if (!title || !topic) return res.status(400).json({ error: "A title and topic are required." });
    const projects = await readProjects();
    const project = { id: crypto.randomUUID(), title: title, topic: topic, status: "Draft", script: req.body.script || null, videoUrl: clean(req.body.videoUrl, 500) || null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    projects.push(project);
    await writeProjects(projects);
    res.status(201).json(project);
  } catch (error) { next(error); }
});

app.put("/api/projects/:id", async function (req, res, next) {
  try {
    const projects = await readProjects();
    const index = projects.findIndex(function (item) { return item.id === req.params.id; });
    if (index < 0) return res.status(404).json({ error: "Project not found." });
    if (req.body.title !== undefined) projects[index].title = clean(req.body.title, 180);
    if (req.body.status && ["Draft", "In review", "Approved"].includes(req.body.status)) projects[index].status = req.body.status;
    if (req.body.script !== undefined) projects[index].script = req.body.script;
    if (req.body.videoUrl !== undefined) projects[index].videoUrl = clean(req.body.videoUrl, 500) || null;
    projects[index].updatedAt = new Date().toISOString();
    await writeProjects(projects);
    res.json(projects[index]);
  } catch (error) { next(error); }
});

app.use(function (error, _req, res, _next) {
  console.error(error);
  if (res.headersSent) return;
  const status = error.type === "entity.parse.failed" ? 400 : (error.status || 500);\n  const message = error.type === "entity.parse.failed" ? "Request body must contain valid JSON." : (status === 404 ? "Output file not found." : "An unexpected server error occurred.");\n  res.status(status).json({ error: message });
});

app.listen(PORT, "127.0.0.1", function () {
  console.log("\nYouTube AI Automation Agent: http://localhost:" + PORT);
  console.log("AI mode: " + (process.env.GEMINI_API_KEY ? "Gemini API" : "local demo generator"));
  console.log("Video rendering: FFmpeg + Windows built-in narration");
});
