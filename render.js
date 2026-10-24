const fs = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const ffmpegPath = require("ffmpeg-static");
const sharp = require("sharp");
const execFileAsync = promisify(execFile);

function escapeXml(value) {
  return String(value || "").replace(/[&<>"']/g, function (char) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char];
  });
}
function wrapWords(value, maxChars, maxLines) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line); line = word;
      if (lines.length >= maxLines) break;
    } else line = (line + " " + word).trim();
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[.…]*$/, "") + "…";
  }
  return lines;
}
function slideSvg(title, heading, visual, index, total) {
  const headingSvg = wrapWords(heading, 27, 2).map(function (line, i) {
    return '<text x="100" y="' + (260 + i * 66) + '" font-family="Arial, sans-serif" font-size="52" font-weight="700" fill="#f5f7ff">' + escapeXml(line) + '</text>';
  }).join("");
  const visualSvg = wrapWords(visual, 44, 3).map(function (line, i) {
    return '<text x="104" y="' + (430 + i * 38) + '" font-family="Arial, sans-serif" font-size="26" fill="#b9c5e2">' + escapeXml(line) + '</text>';
  }).join("");
  const safeTitle = escapeXml(wrapWords(title, 58, 1)[0] || "Video draft");
  return '<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#10172c"/><stop offset="100%" stop-color="#29345c"/></linearGradient></defs>' +
    '<rect width="1280" height="720" fill="url(#bg)"/><circle cx="1120" cy="90" r="250" fill="#817bff" opacity=".12"/>' +
    '<rect x="76" y="74" width="8" height="38" rx="4" fill="#a9b4ff"/>' +
    '<text x="104" y="102" font-family="Arial, sans-serif" font-size="22" letter-spacing="3" fill="#a9b4ff">YOUTUBE AI STUDIO</text>' +
    '<text x="104" y="168" font-family="Arial, sans-serif" font-size="25" fill="#d4dcf3">' + safeTitle + '</text>' +
    headingSvg + visualSvg +
    '<line x1="104" y1="610" x2="1176" y2="610" stroke="#65719a" stroke-width="2" opacity=".55"/>' +
    '<text x="104" y="655" font-family="Arial, sans-serif" font-size="18" fill="#aab5d2">AI-generated draft • Review before publishing</text>' +
    '<text x="1176" y="655" text-anchor="end" font-family="Arial, sans-serif" font-size="18" fill="#aab5d2">' + index + ' / ' + total + '</text></svg>';
}

async function findOnPath(names) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch (_) { /* try the next directory */ }
    }
  }
  return null;
}

// Finds an offline text-to-speech engine for this computer, or returns null.
async function detectNarrationEngine() {
  if (process.platform === "win32") {
    return { id: "windows-sapi", label: "Windows built-in text-to-speech" };
  }
  if (process.platform === "darwin") {
    const say = await findOnPath(["say"]);
    return say ? { id: "macos-say", label: "macOS built-in text-to-speech", command: say } : null;
  }
  const espeak = await findOnPath(["espeak-ng", "espeak"]);
  return espeak ? { id: "espeak", label: "eSpeak NG text-to-speech", command: espeak } : null;
}

function missingEngineMessage() {
  if (process.platform === "darwin") return "Offline narration needs the macOS 'say' command, which was not found.";
  return "Offline narration needs a text-to-speech engine. Install espeak-ng (for example: sudo apt install espeak-ng) and try again.";
}

// Writes the narration audio file and returns its path.
async function synthesizeNarration(engine, textPath, outputDir) {
  const options = { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 };
  if (engine.id === "windows-sapi") {
    const wavPath = path.join(outputDir, "narration.wav");
    const psPath = path.join(outputDir, "make-narration.ps1");
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Speech",
      "$text = Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8",
      "$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$speech.Rate = 0",
      "$speech.Volume = 100",
      "$speech.SetOutputToWaveFile($args[1])",
      "$speech.Speak($text)",
      "$speech.Dispose()"
    ].join("\r\n");
    await fs.writeFile(psPath, ps, "utf8");
    await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psPath, textPath, wavPath], options);
    return wavPath;
  }
  if (engine.id === "macos-say") {
    const aiffPath = path.join(outputDir, "narration.aiff");
    await execFileAsync(engine.command, ["-f", textPath, "-o", aiffPath], options);
    return aiffPath;
  }
  const wavPath = path.join(outputDir, "narration.wav");
  await execFileAsync(engine.command, ["-f", textPath, "-w", wavPath], options);
  return wavPath;
}

// Reads the real length of an audio file from FFmpeg's header output.
async function audioDurationSeconds(file) {
  try {
    await execFileAsync(ffmpegPath, ["-hide_banner", "-i", file], { maxBuffer: 1024 * 1024 });
  } catch (error) {
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(error && error.stderr || ""));
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return null;
}

async function renderVideo(draft, outputDir) {
  if (!ffmpegPath) throw new Error("FFmpeg binary is unavailable. Reinstall dependencies with npm install.");
  if (!draft || typeof draft.narration !== "string" || draft.narration.trim().length < 20) {
    throw new Error("A generated script with narration is required.");
  }
  const engine = await detectNarrationEngine();
  if (!engine) throw new Error(missingEngineMessage());

  const title = String(draft.title || "Untitled video").slice(0, 180);
  const narration = draft.narration.slice(0, 24000);
  const rawScenes = Array.isArray(draft.scenes)
    ? draft.scenes.filter(function (scene) { return scene && typeof scene === "object"; }).slice(0, 12)
    : [];
  const scenes = rawScenes.length ? rawScenes : [{ heading: title, visual: "An introduction to " + title, narration: narration }];

  await fs.mkdir(outputDir, { recursive: true });
  try {
    const textPath = path.join(outputDir, "narration.txt");
    await fs.writeFile(textPath, narration, "utf8");
    const audioPath = await synthesizeNarration(engine, textPath, outputDir);

    // Use the real narration length so the video never cuts the speech short.
    const totalWords = narration.split(/\s+/).filter(Boolean).length;
    const audioSeconds = await audioDurationSeconds(audioPath);
    const estimatedSeconds = audioSeconds
      ? audioSeconds + 0.3
      : Math.max(8, totalWords / 2.25 + scenes.length * 1.2);
    const sceneWordCounts = scenes.map(function (scene) {
      return Math.max(1, String(scene.narration || scene.heading || "").split(/\s+/).filter(Boolean).length);
    });
    const wordSum = sceneWordCounts.reduce(function (sum, count) { return sum + count; }, 0);
    const imagePaths = [];
    const durations = [];
    for (let i = 0; i < scenes.length; i++) {
      const imagePath = path.join(outputDir, "scene-" + String(i + 1).padStart(2, "0") + ".png");
      await sharp(Buffer.from(slideSvg(title, scenes[i].heading || ("Scene " + (i + 1)), scenes[i].visual || "", i + 1, scenes.length))).png().toFile(imagePath);
      imagePaths.push(imagePath);
      durations.push(Math.max(2.5, estimatedSeconds * sceneWordCounts[i] / wordSum));
    }
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    const filterParts = [];
    imagePaths.forEach(function (imagePath, i) {
      args.push("-loop", "1", "-framerate", "30", "-t", durations[i].toFixed(2), "-i", imagePath);
      filterParts.push("[" + i + ":v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v" + i + "]");
    });
    args.push("-i", audioPath);
    filterParts.push(imagePaths.map(function (_p, i) { return "[v" + i + "]"; }).join("") + "concat=n=" + imagePaths.length + ":v=1:a=0[outv]");
    args.push("-filter_complex", filterParts.join(";"), "-map", "[outv]", "-map", imagePaths.length + ":a:0",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", path.join(outputDir, "video.mp4"));
    await execFileAsync(ffmpegPath, args, { windowsHide: true, timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
    const stat = await fs.stat(path.join(outputDir, "video.mp4"));
    return { file: "video.mp4", url: "/outputs/" + path.basename(outputDir) + "/video.mp4", bytes: stat.size,
      durationEstimateSeconds: Math.round(estimatedSeconds), scenes: scenes.length, narration: engine.label };
  } catch (error) {
    // Do not leave half-finished render folders behind.
    await fs.rm(outputDir, { recursive: true, force: true }).catch(function () {});
    throw error;
  }
}
module.exports = { renderVideo, detectNarrationEngine };
