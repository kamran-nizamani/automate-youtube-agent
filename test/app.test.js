const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

let child;
let baseUrl;
let tempDir;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("local API smoke test: health, generation, projects, and validation", async () => {
  const port = await freePort();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-agent-test-"));
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(port), DATA_DIR: tempDir, GEMINI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk.toString(); });
  child.stderr.on("data", chunk => { logs += chunk.toString(); });
  baseUrl = "http://127.0.0.1:" + port;

  let health = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error("Server exited early. Logs: " + logs);
    try {
      const response = await fetch(baseUrl + "/api/health");
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(health, "server should start and answer health checks. Logs: " + logs);
  assert.equal(health.ok, true);
  assert.equal(health.aiConfigured, false);

  const missingTopic = await fetch(baseUrl + "/api/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "x" })
  });
  assert.equal(missingTopic.status, 400);

  const generatedResponse = await fetch(baseUrl + "/api/generate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic: "How AI agents work", niche: "Technology Education", duration: 1, tone: "Educational" })
  });
  assert.equal(generatedResponse.status, 200);
  const draft = await generatedResponse.json();
  assert.equal(draft.generator, "local-demo");
  assert.ok(draft.narration.length > 20);
  assert.ok(Array.isArray(draft.scenes) && draft.scenes.length > 0);

  const saveResponse = await fetch(baseUrl + "/api/projects", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: draft.title, topic: draft.input.topic, script: draft })
  });
  assert.equal(saveResponse.status, 201);
  const saved = await saveResponse.json();
  const listResponse = await fetch(baseUrl + "/api/projects");
  assert.equal(listResponse.status, 200);
  const projects = await listResponse.json();
  assert.ok(projects.some(project => project.id === saved.id));

  const invalidRender = await fetch(baseUrl + "/api/render", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft: {} })
  });
  assert.equal(invalidRender.status, 400);

  const malformedJson = await fetch(baseUrl + "/api/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{invalid"
  });
  assert.equal(malformedJson.status, 400);
  const malformedPayload = await malformedJson.json();
  assert.match(malformedPayload.error, /valid JSON/i);
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});
