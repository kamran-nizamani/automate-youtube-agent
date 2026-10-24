# YouTube AI Automation Agent

A local-first YouTube creator workflow built from scratch. Milestone 1 delivers a working dashboard, script-draft generator, and local project queue.

## Features

- Generate a draft from topic, niche, target length, and narration style.
- Built-in local demo generator works without an API key.
- Optional Gemini API integration.
- Save projects locally in data/projects.json.
- Review and copy generated narration.
- Publishing remains manual; no YouTube account access is used in this milestone.

## Requirements

- Node.js 20 or newer
- npm

## Run on Windows

Open PowerShell in the project folder:

    npm install
    Copy-Item .env.example .env
    npm start

Open http://localhost:3456 in your browser.

For automatic server restarts, run npm run dev.

## Optional Gemini API

1. Get an API key from Google AI Studio and check the current free-tier limits.
2. Open .env and set GEMINI_API_KEY=your_key_here.
3. Optionally set GEMINI_MODEL=gemini-2.5-flash.
4. Restart the server.

Never commit .env or expose your API key. AI output is a draft, not verified research. Fact-check claims and verify media rights before publishing.

## API

- GET /api/health — health and AI configuration
- GET /api/projects — list saved projects
- POST /api/generate — generate a script draft
- POST /api/projects — save a project
- PUT /api/projects/:id — update title, status, or script

## Roadmap

1. Draft studio (current): topic → script → save project.
2. Research and source tracking, storyboard editor, SEO metadata.
3. Voice generation, licensed/owned visuals, subtitles, FFmpeg MP4 rendering.
4. YouTube OAuth, upload preview, explicit human approval, publishing.
5. Analytics and feedback loop.

## Stack

Node.js, Express, vanilla HTML/CSS/JavaScript, optional Gemini API, and local JSON persistence. JSON keeps milestone 1 dependency-light; we can move to SQLite as workflows expand.
