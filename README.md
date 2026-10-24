# YouTube AI Automation Agent

A local-first YouTube creator workflow. The app can draft scripts, save projects locally, and render an actual MP4 with scene cards and offline narration on Windows, macOS, and Linux.

## Current working features

- Topic-to-script workflow with title, hook, narration, scene plan, description, and tags.
- Optional Gemini API integration for AI-generated script drafts.
- Built-in demo script generator when no API key is configured (not real AI research).
- Local project persistence in `data/projects.json`.
- **Render MP4** creates scene-card images, offline text-to-speech narration, and a playable H.264/AAC MP4 using FFmpeg. The video length follows the real narration length, so speech is never cut short.
- Preview the MP4 in the dashboard and download it to your computer.
- Output files stay in the local `data/renders` folder; they are not committed to Git.
- No YouTube publishing occurs automatically. Review the result before uploading.

## Requirements

- Windows 10/11, macOS, or Linux
- Node.js 20 or newer and npm
- Internet connection during initial `npm install` to download dependencies
- An offline text-to-speech engine for **Render MP4**:
  - Windows: built in (PowerShell and System.Speech).
  - macOS: built in (`say`).
  - Linux: install `espeak-ng` (for example `sudo apt install espeak-ng`).

Without a speech engine the app still generates and saves scripts; the **Render MP4** button is disabled and the dashboard explains why.

## Run

Open a terminal in the repository folder.

Windows (Command Prompt):

    npm install
    copy .env.example .env
    npm start

macOS / Linux:

    npm install
    cp .env.example .env
    npm start

Open http://localhost:3456. Keep the terminal open while using the app. The server binds to `127.0.0.1` so this local prototype is not exposed to other devices on your network by default.

If the server is already running, press `Ctrl+C`, run `git pull`, then run `npm install` and `npm test` before restarting with `npm start`.

## Enable real AI script generation (optional)

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Open `.env` in any text editor and set `GEMINI_API_KEY=your_key_here`.
3. Save the file and restart `npm start`.

Check current model access and free-tier limits before use. Never share or commit the API key. Without the key, the script generator uses a clearly labeled local demo template.

## Render an MP4

1. Generate a script.
2. Click **Render MP4** below the script.
3. Wait while the app creates narration and the scene-card video.
4. Preview it in the dashboard and click **Download MP4**.

Rendering is local and uses your computer's offline speech engine (Windows speech, macOS `say`, or `espeak-ng` on Linux). Only one video is rendered at a time. The current renderer creates a narrated slideshow from generated scene cards; it does not yet create photorealistic AI video, source-backed research, or animated stock footage. Check narration pronunciation, facts, media rights, and the final video before publishing.

## API

- `GET /api/health` — server and configuration status, including whether video rendering is available
- `GET /api/projects` — list saved projects
- `POST /api/generate` — generate a script draft
- `POST /api/render` — render a draft to MP4
- `POST /api/projects` — save a project
- `PUT /api/projects/:id` — update title, status, script, or video URL
- `/outputs/:renderId/video.mp4` — locally rendered output

## Roadmap

1. Draft studio and local project queue.
2. Real source-backed research, editable storyboard, and SEO checks.
3. **First local MP4 rendering pipeline added:** offline narration + scene-card slideshow.
4. Better visuals, captions, progress tracking, and export bundles.
5. YouTube OAuth, private/unlisted upload, explicit human approval, and publishing.
6. Analytics and feedback loop.

## Stack

Node.js, Express, vanilla HTML/CSS/JavaScript, optional Gemini API, FFmpeg, Sharp, offline text-to-speech (Windows System.Speech, macOS `say`, or `espeak-ng`), and local JSON persistence. JSON is used to keep the prototype dependency-light; SQLite can be introduced as the workflow grows.
