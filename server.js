require("dotenv").config({ quiet: true });

const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { renderVideo, detectNarrationEngine } = require("./render");

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
  // Write to a temp file first so a crash can never leave projects.json half-written.
  const tempFile = DATA_FILE + "." + process.pid + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(projects, null, 2) + "\n", "utf8");
  await fs.rename(tempFile, DATA_FILE);
}

// Read-modify-write runs one at a time so two quick saves cannot overwrite each other.
let projectsQueue = Promise.resolve();
function updateProjects(change) {
  const run = projectsQueue.then(async function () {
    const projects = await readProjects();
    const result = await change(projects);
    if (result && result.save) await writeProjects(projects);
    return result && result.value;
  });
  projectsQueue = run.catch(function () {});
  return run;
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
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.7 } }),
    signal: AbortSignal.timeout(45000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload && payload.error ? payload.error.message : "Gemini request failed (" + response.status + ")");
  const text = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content && Array.isArray(payload.candidates[0].content.parts) ? payload.candidates[0].content.parts.map(function (p) { return p.text || ""; }).join("") : "";
  if (!text) throw new Error("Gemini returned an empty response.");
  return normalizeDraft(parseModelJson(text), input);
}

// Models sometimes wrap JSON in a markdown fence even when asked not to.
function parseModelJson(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped);
  } catch (_) {
    throw new Error("Gemini returned a script that was not valid JSON. Please try again.");
  }
}

// Makes sure an AI draft always has the fields the dashboard and renderer rely on.
function normalizeDraft(raw, input) {
  const draft = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const scenes = (Array.isArray(draft.scenes) ? draft.scenes : [])
    .filter(function (scene) { return scene && typeof scene === "object"; })
    .map(function (scene, i) {
      return {
        scene: i + 1,
        heading: clean(scene.heading, 180) || "Scene " + (i + 1),
        visual: clean(scene.visual, 400),
        narration: clean(scene.narration, 4000)
      };
    });
  let narration = typeof draft.narration === "string" ? draft.narration.trim() : "";
  if (!narration && scenes.length) {
    narration = [clean(draft.hook, 600)].concat(scenes.map(function (s) { return s.narration; })).filter(Boolean).join("\n\n");
  }
  if (!narration) throw new Error("Gemini did not return any narration. Please try again.");
  return {
    title: clean(draft.title, 180) || input.topic,
    hook: clean(draft.hook, 600),
    narration: narration,
    scenes: scenes,
    description: typeof draft.description === "string" ? draft.description : "",
    tags: Array.isArray(draft.tags) ? draft.tags.map(function (tag) { return clean(tag, 60); }).filter(Boolean).slice(0, 30) : [],
    estimatedWordCount: Number(draft.estimatedWordCount) || narration.split(/\s+/).filter(Boolean).length,
    tone: input.tone,
    durationMinutes: input.duration,
    generator: "gemini",
    note: "AI-generated first draft. Verify factual claims and sources before publishing."
  };
}

let narrationEngine = null;

app.get("/api/health", function (_req, res) {
  res.json({
    ok: true,
    app: "YouTube AI Automation Agent",
    milestone: 2,
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
    videoRendering: Boolean(narrationEngine),
    narrationEngine: narrationEngine ? narrationEngine.label : null,
    platform: process.platform
  });
});

app.get("/api/projects", async function (_req, res, next) {
  try {
    const projects = await readProjects();
    res.json(projects.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }));
  } catch (error) { next(error); }
});

app.post("/api/generate", async function (req, res) {
  try {
    const body = req.body || {};
    const input = {
      topic: clean(body.topic, 180),
      niche: clean(body.niche, 80),
      tone: clean(body.tone || "Clear and engaging", 80),
      duration: Math.max(1, Math.min(20, Number(body.duration) || 3))
    };
    if (input.topic.length < 3) return res.status(400).json({ error: "Please enter a topic with at least 3 characters." });
    res.json(Object.assign(await generateWithGemini(input), { input: input }));
  } catch (error) {
    console.error("Script generation failed:", error.message);
    res.status(502).json({ error: "Could not generate a script: " + error.message });
  }
});

let renderInProgress = false;

app.post("/api/render", async function (req, res) {
  const draft = req.body && req.body.draft;
  if (!draft || typeof draft.narration !== "string") {
    return res.status(400).json({ error: "Generate a script before rendering a video." });
  }
  // Rendering is CPU-heavy, so only one video is built at a time.
  if (renderInProgress) {
    return res.status(409).json({ error: "Another video is still rendering. Please wait for it to finish." });
  }
  renderInProgress = true;
  try {
    const id = crypto.randomUUID();
    const outputDir = path.join(RENDERS_DIR, id);
    const result = await renderVideo(draft, outputDir);
    res.status(201).json(Object.assign({ id: id, title: clean(draft.title, 180) || "Untitled video" }, result));
  } catch (error) {
    console.error("Video rendering failed:", error.message);
    res.status(500).json({ error: "Video rendering failed: " + error.message });
  } finally {
    renderInProgress = false;
  }
});

app.post("/api/projects", async function (req, res, next) {
  try {
    const body = req.body || {};
    const title = clean(body.title, 180);
    const topic = clean(body.topic, 180);
    if (!title || !topic) return res.status(400).json({ error: "A title and topic are required." });
    const now = new Date().toISOString();
    const project = { id: crypto.randomUUID(), title: title, topic: topic, status: "Draft", script: body.script || null, videoUrl: clean(body.videoUrl, 500) || null, createdAt: now, updatedAt: now };
    await updateProjects(function (projects) {
      projects.push(project);
      return { save: true };
    });
    res.status(201).json(project);
  } catch (error) { next(error); }
});

app.put("/api/projects/:id", async function (req, res, next) {
  try {
    const body = req.body || {};
    const updated = await updateProjects(function (projects) {
      const project = projects.find(function (item) { return item.id === req.params.id; });
      if (!project) return { save: false, value: null };
      if (body.title !== undefined) project.title = clean(body.title, 180) || project.title;
      if (body.status && ["Draft", "In review", "Approved"].includes(body.status)) project.status = body.status;
      if (body.script !== undefined) project.script = body.script;
      if (body.videoUrl !== undefined) project.videoUrl = clean(body.videoUrl, 500) || null;
      project.updatedAt = new Date().toISOString();
      return { save: true, value: project };
    });
    if (!updated) return res.status(404).json({ error: "Project not found." });
    res.json(updated);
  } catch (error) { next(error); }
});

app.use(function (error, _req, res, _next) {
  console.error(error);
  if (res.headersSent) return;
  const status = error.type === "entity.parse.failed" ? 400 : (error.status || 500);
  const message = error.type === "entity.parse.failed" ? "Request body must contain valid JSON." : (status === 404 ? "Output file not found." : "An unexpected server error occurred.");
  res.status(status).json({ error: message });
});

detectNarrationEngine().catch(function () { return null; }).then(function (engine) {
  narrationEngine = engine;
  const server = app.listen(PORT, "127.0.0.1", function () {
    console.log("\nYouTube AI Automation Agent: http://localhost:" + PORT);
    console.log("AI mode: " + (process.env.GEMINI_API_KEY ? "Gemini API" : "local demo generator"));
    console.log("Video rendering: " + (engine
      ? "FFmpeg + " + engine.label
      : "unavailable (no offline text-to-speech engine found; on Linux install espeak-ng)"));
  });
  server.on("error", function (error) {
    if (error.code === "EADDRINUSE") {
      console.error("Port " + PORT + " is already in use. Stop the other program or set a different PORT in .env.");
    } else {
      console.error("Could not start the server:", error.message);
    }
    process.exit(1);
  });
});
