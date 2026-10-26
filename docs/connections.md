# Connections

The **Connections** screen in the dashboard is where you add provider keys, sign in to YouTube, and prepare the slideshow renderer. Nothing here needs a terminal or a config file. Open it from the sidebar (or press `g` then `k`, or use the command palette with `Ctrl K`).

When setup is incomplete the dashboard opens on this screen automatically. As soon as the three required steps are done, the agents start by themselves. Changing a key later restarts them with the new settings, usually in under a second, without restarting the server.

## Required steps

| Step | What to do |
| --- | --- |
| AI provider for scripts | Open a provider card, paste its key, choose a model, and press **Save & test**. One provider is enough. |
| YouTube credentials | Enter the Client ID and Client secret of a Google OAuth client of type **Desktop app**. The card explains how to create one. |
| Sign in to YouTube | Press **Sign in with Google**, approve every permission, and come back. The page updates by itself. |

Recommended extras are shown in the progress list: narration, image generation, and the video renderer.

## Providers

- **Text:** Gemini, OpenAI, OpenRouter, Kimi, MiMo, GLM, DeepSeek, and MiniMax. You can save several keys and choose which one writes scripts with **Use for scripts**. Gemini and OpenAI keys also power images and narration.
- **Narration:** ElevenLabs (key and voice ID). Narration uses ElevenLabs first, then OpenAI, then Gemini.
- **AI video (optional):** Seedance 2.5 (Replicate), MiniMax H3, Kling 3 Omni, and Wan 2.7. Gemini Omni uses your Gemini key. The free local slideshow stays the default; choose a paid provider and its seconds cap in **Setup**.

**Save & test** stores the key and then makes one tiny live request. **Test** checks a saved key, or a key you have typed but not saved yet. Error messages say what to do next (rejected key, out of quota, unreachable network) and never repeat the key.

A key already set in `.env` shows as **From .env**. It works, but it can only be changed in `.env`. A key saved in the dashboard takes priority over the environment.

## YouTube sign-in

1. Create a Google Cloud project, enable **YouTube Data API v3** and **YouTube Analytics API**, add your Google account as a **test user**, and create an OAuth client of type **Desktop app**.
2. Paste the Client ID and secret into the YouTube card and press **Save credentials**.
3. Press **Sign in with Google**. Google sends you back to `http://localhost:<port>/auth/youtube/callback`, which finishes the sign-in and returns you to the dashboard.

While your Google app is in **Testing** mode, Google ends the sign-in after 7 days; press **Sign in again**. If Google does not grant every permission, the card tells you which features will be limited. **Disconnect** revokes the token with Google and removes it from this computer.

## Slideshow renderer

Slideshow videos are rendered with a Chromium browser. The app uses, in order: the path in `CHROMIUM_PATH`, Playwright's Chromium, then Google Chrome, Chromium, or Edge installed on your computer. If none is found, **Install renderer** downloads Playwright's Chromium (about 150 MB, one time) and shows progress.

## Where things are stored and how they are protected

- Keys and tokens are saved in `config/credentials.json` and `config/tokens.json`, readable only by your user account (mode `0600`), and are excluded from Git.
- Keys are masked in the dashboard (only the last four characters are shown), are never returned in full by the API, and are removed from error messages and logs.
- Every Connections route answers only requests addressed to this computer (`localhost`, `127.0.0.1`, or `::1`) and rejects cross-site requests. This blocks DNS-rebinding and web pages you have open from changing your keys. To use another address, add it to `ALLOWED_HOSTS` in `.env`.
- If `API_KEY` is set, every Connections route also requires it (the dashboard prompts for it once).
- The Google sign-in uses a one-time `state` value and PKCE. The callback ignores any request that was not started from this dashboard.
- Settings such as `PORT`, `HOST`, and `API_KEY` stay in `.env` on purpose, so a web page can never change how the server is exposed.

## API

All routes are under `/api/connections` and need the `x-api-key` header when `API_KEY` is set.

| Route | Purpose |
| --- | --- |
| `GET /api/connections` | Status of every provider, YouTube, and the renderer (keys masked) |
| `PUT /api/connections/text/:id` | Save a text provider key and model (`apiKey` may be omitted to keep the saved key) |
| `POST /api/connections/text/:id/activate` | Use this provider for scripts |
| `POST /api/connections/text/:id/test` | Live check; send `apiKey` and `model` to test without saving |
| `DELETE /api/connections/text/:id` | Remove a saved key |
| `PUT /api/connections/services/:id` | Save ElevenLabs or a video provider (`elevenlabs`, `seedance`, `minimax_h3`, `kling`, `wan`) |
| `POST /api/connections/services/:id/test` | Free check where the provider offers one |
| `DELETE /api/connections/services/:id` | Remove saved details |
| `PUT /api/connections/youtube/client` | Save the OAuth Client ID and secret |
| `POST /api/connections/youtube/start` | Returns the Google sign-in URL |
| `POST /api/connections/youtube/test` | Confirms the connected channel |
| `POST /api/connections/youtube/disconnect` | Revoke and remove the sign-in |
| `POST /api/renderer/install` | Download Playwright's Chromium |
| `GET /auth/youtube/callback` | Google's redirect target (not an API route) |
