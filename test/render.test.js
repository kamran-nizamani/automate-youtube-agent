const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { detectNarrationEngine } = require("../render");

test("renderer produces a playable MP4 with audio", { timeout: 240000 }, async t => {
  if (!await detectNarrationEngine()) {
    t.skip("No offline narration engine found (Windows speech, macOS say, or espeak-ng)");
    return;
  }
  const portServer = net.createServer();
  await new Promise((resolve, reject) => {
    portServer.once("error", reject);
    portServer.listen(0, "127.0.0.1", resolve);
  });
  const port = portServer.address().port;
  await new Promise((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-agent-render-test-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(port), DATA_DIR: tempDir, GEMINI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk.toString(); });
  child.stderr.on("data", chunk => { logs += chunk.toString(); });
  const baseUrl = "http://127.0.0.1:" + port;

  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error("Server exited early. " + logs);
      try {
        const response = await fetch(baseUrl + "/api/health");
        if (response.ok) { ready = true; break; }
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, "server should start before render test. " + logs);

    const draft = {
      title: "Renderer integration test",
      narration: "This is a short integration test. The video should include spoken narration and two visual scenes.",
      scenes: [
        { scene: 1, heading: "Scene One", visual: "A simple introduction", narration: "This is the first scene." },
        { scene: 2, heading: "Scene Two", visual: "A simple conclusion", narration: "This is the second scene." }
      ]
    };
    const response = await fetch(baseUrl + "/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft })
    });
    const payload = await response.json();
    assert.equal(response.status, 201, "render endpoint should succeed: " + JSON.stringify(payload));
    assert.match(payload.url, /^\/outputs\/[a-f0-9-]+\/video\.mp4$/);
    assert.ok(payload.bytes > 10000, "rendered MP4 should not be empty");

    const videoResponse = await fetch(baseUrl + payload.url);
    assert.equal(videoResponse.status, 200);
    const video = Buffer.from(await videoResponse.arrayBuffer());
    assert.ok(video.length > 10000);
    assert.equal(video.toString("ascii", 4, 8), "ftyp", "output should have an MP4 file signature");
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
