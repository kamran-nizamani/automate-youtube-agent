'use strict';

// Everything the dashboard's Connections screen needs: saving provider keys, YouTube sign-in,
// live key checks, and a status summary that never contains a full secret.

const crypto = require('crypto');
const { google } = require('googleapis');
const { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL } = require('./ai-text-service');

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

const KEY_URLS = {
  gemini: 'https://aistudio.google.com/apikey',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/keys',
  kimi: 'https://platform.kimi.ai',
  mimo: 'https://mimo.mi.com',
  glm: 'https://z.ai',
  deepseek: 'https://platform.deepseek.com',
  minimax: 'https://platform.minimax.io'
};

const COVERS = {
  gemini: ['Scripts', 'Images', 'Narration', 'AI video'],
  openai: ['Scripts', 'Images', 'Narration']
};

// Non-text services. `store` is the key inside credentials.json that the pipeline already reads.
const SERVICES = [
  {
    id: 'elevenlabs', name: 'ElevenLabs', group: 'narration', store: 'elevenLabs',
    description: 'Highest-quality narration (Eleven v3). Used first when configured.',
    keyUrl: 'https://elevenlabs.io', testable: true,
    fields: [
      { name: 'apiKey', label: 'API key', secret: true },
      { name: 'voiceId', label: 'Voice ID', secret: false, pattern: /^[A-Za-z0-9_-]{6,64}$/, hint: 'A voice that exists in your ElevenLabs account.' }
    ]
  },
  {
    id: 'seedance', name: 'Seedance 2.5 (Replicate)', group: 'video', store: 'replicate',
    description: 'Cinematic AI video clips of 4-30 seconds, billed per second by Replicate.',
    keyUrl: 'https://replicate.com/account/api-tokens', testable: true,
    fields: [{ name: 'apiKey', label: 'Replicate API token', secret: true }]
  },
  {
    id: 'minimax_h3', name: 'MiniMax H3', group: 'video', store: 'minimax',
    description: 'AI video with native stereo audio, 4-15 second clips.',
    keyUrl: 'https://platform.minimax.io', testable: false,
    fields: [{ name: 'apiKey', label: 'MiniMax video API key', secret: true }]
  },
  {
    id: 'kling', name: 'Kling 3 Omni', group: 'video', store: 'kling',
    description: 'Storyboards and consistent characters, 3-15 second clips.',
    keyUrl: 'https://klingai.com', testable: false,
    fields: [
      { name: 'accessKey', label: 'Access key', secret: true },
      { name: 'secretKey', label: 'Secret key', secret: true }
    ]
  },
  {
    id: 'wan', name: 'Wan 2.7 (Alibaba)', group: 'video', store: 'wan',
    description: 'Efficient generation and continuation, 2-15 second clips.',
    keyUrl: 'https://dashscope.console.aliyun.com', testable: false,
    fields: [{ name: 'apiKey', label: 'DashScope API key', secret: true }]
  }
];

class ConnectionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ConnectionError';
    this.status = status;
  }
}

function mask(value) {
  const text = String(value || '');
  if (!text) return '';
  return text.length <= 8 ? '••••' : `••••${text.slice(-4)}`;
}

// Provider error messages sometimes echo part of a key. Remove known secrets and anything
// that looks like a token before a message is logged or returned.
function redact(message, secrets = []) {
  let text = String(message || '');
  for (const secret of secrets) {
    if (secret && String(secret).length >= 6) text = text.split(String(secret)).join('••••');
  }
  return text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{6,}/g, '$1-••••')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, 'AIza••••')
    .replace(/\bGOCSPX-[0-9A-Za-z_-]{6,}/g, 'GOCSPX-••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1••••')
    .slice(0, 400);
}

// Turns an SDK error into a sentence that says what to do next.
function friendlyProviderError(error, providerName, model, secrets) {
  const status = Number(error?.status || error?.response?.status || error?.code);
  const message = String(error?.message || '');
  if (status === 401 || status === 403 || /api key not valid|invalid api key|incorrect api key|unauthorized/i.test(message)) {
    return `${providerName} rejected this key. Check that it was copied in full and is still active.`;
  }
  if (status === 404) return `${providerName} has no model called "${model}". Choose another model.`;
  if (status === 429) return `${providerName} accepted the request but reports this key is rate limited or out of credits.`;
  if (/connection error|enotfound|econnrefused|econnreset|fetch failed|timed? ?out|network/i.test(message)) {
    return `Could not reach ${providerName}. Check your internet connection or firewall.`;
  }
  return redact(message, secrets) || `${providerName} rejected the request.`;
}

function cleanSecret(value, label) {
  if (typeof value !== 'string') throw new ConnectionError(`${label} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 512) throw new ConnectionError(`${label} looks too short or too long. Paste the full value.`);
  if (/\s/.test(trimmed)) throw new ConnectionError(`${label} must not contain spaces or line breaks.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new ConnectionError(`${label} contains characters that are not allowed.`);
  return trimmed;
}

function cleanModel(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:/-]{1,100}$/.test(value.trim())) {
    throw new ConnectionError('Model name contains characters that are not allowed.');
  }
  return value.trim();
}

class ConnectionService {
  constructor(credentialManager, options = {}) {
    this.cm = credentialManager;
    this.getPort = options.getPort || (() => Number(process.env.PORT || 3456));
    this.onChange = options.onChange || (async () => ({ ok: true }));
    this.fetch = options.fetch || globalThis.fetch;
    this.logger = options.logger || { warn() {}, info() {} };
    this.googleClient = options.googleClient || google;
    this.pendingAuth = new Map();
    this.queue = Promise.resolve();
  }

  get credentials() {
    return this.cm.credentials;
  }

  // Credential edits run one at a time so two quick saves cannot overwrite each other.
  serialize(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  textProviderIds() {
    return ['gemini', 'openai', ...Object.keys(PROVIDERS).filter(id => id !== 'openai')];
  }

  textProviderMeta(id) {
    if (id === 'gemini') {
      return { id, name: 'Google Gemini', models: [...GEMINI_MODELS], defaultModel: GEMINI_DEFAULT_MODEL, envKey: 'GEMINI_API_KEY' };
    }
    const preset = PROVIDERS[id];
    if (!preset) throw new ConnectionError('Unknown AI provider.', 404);
    return { id, name: preset.name, models: [...preset.models], defaultModel: preset.defaultModel, envKey: preset.envKey };
  }

  // Where a provider's saved key lives. Gemini and OpenAI keep their historical spots because
  // image and narration code reads them; the rest live under textKeys.
  dedicatedEntry(id) {
    const c = this.credentials;
    if (id === 'gemini' && c.gemini?.apiKey) return c.gemini;
    if (id === 'openai' && c.openai?.apiKey) return c.openai;
    if (c.textKeys?.[id]?.apiKey) return c.textKeys[id];
    return null;
  }

  textEntry(id) {
    const c = this.credentials;
    return this.dedicatedEntry(id) || (c.aiProvider?.provider === id && c.aiProvider.apiKey ? c.aiProvider : null);
  }

  // A key saved by the old command-line setup lives only in credentials.aiProvider. Copy it to
  // its own slot so choosing another provider later does not overwrite (and lose) it.
  migrateLegacyProvider() {
    const ap = this.credentials.aiProvider;
    if (ap?.provider && ap.apiKey && this.textProviderIds().includes(ap.provider) && !this.dedicatedEntry(ap.provider)) {
      this.setTextEntry(ap.provider, { apiKey: ap.apiKey, model: ap.model });
    }
  }

  setTextEntry(id, entry) {
    const c = this.credentials;
    if (id === 'gemini') c.gemini = entry;
    else if (id === 'openai') c.openai = entry;
    else {
      c.textKeys = { ...(c.textKeys || {}), [id]: entry };
    }
  }

  clearTextEntry(id) {
    const c = this.credentials;
    if (id === 'gemini') delete c.gemini;
    else if (id === 'openai') delete c.openai;
    if (c.textKeys) {
      delete c.textKeys[id];
      if (!Object.keys(c.textKeys).length) delete c.textKeys;
    }
    if (c.aiProvider?.provider === id) delete c.aiProvider;
    if (c.textProvider === id) delete c.textProvider;
  }

  envKeyFor(id) {
    const meta = this.textProviderMeta(id);
    return process.env[meta.envKey] ? meta.envKey : null;
  }

  // The provider AITextService will really use, mirroring its own selection order.
  effectiveTextProvider() {
    const c = this.credentials;
    if (c.aiProvider?.provider && c.aiProvider.apiKey) return c.aiProvider.provider;
    for (const [id, preset] of Object.entries(PROVIDERS)) {
      if (process.env[preset.envKey]) return id;
    }
    if (c.gemini?.apiKey || process.env.GEMINI_API_KEY) return 'gemini';
    return null;
  }

  // Keeps credentials.aiProvider (read by the pipeline) in step with the chosen provider.
  syncActiveProvider() {
    const c = this.credentials;
    this.migrateLegacyProvider();
    let active = c.textProvider;
    if (!active || !this.textEntry(active)) {
      active = c.aiProvider?.provider && this.textEntry(c.aiProvider.provider)
        ? c.aiProvider.provider
        : this.textProviderIds().find(id => this.textEntry(id));
    }
    if (!active) {
      delete c.textProvider;
      delete c.aiProvider;
      return null;
    }
    const entry = this.textEntry(active);
    c.textProvider = active;
    c.aiProvider = { provider: active, apiKey: entry.apiKey, model: entry.model || this.textProviderMeta(active).defaultModel };
    return active;
  }

  async persist() {
    await this.cm.saveCredentials();
  }

  async afterChange() {
    try {
      const result = await this.onChange();
      return result || { ok: true };
    } catch (error) {
      this.logger.warn(`Reload after credential change failed: ${redact(error.message)}`);
      return { ok: false, error: redact(error.message) };
    }
  }

  // ---- Status -------------------------------------------------------------------------

  youtubeState() {
    const c = this.credentials;
    const tokens = this.cm.tokens?.youtube || null;
    const granted = String(tokens?.scope || '').split(/\s+/).filter(Boolean);
    return {
      clientConfigured: Boolean(c.youtube?.client_id && c.youtube?.client_secret),
      clientId: c.youtube?.client_id ? mask(c.youtube.client_id.replace(/\.apps\.googleusercontent\.com$/, '')) : '',
      connected: Boolean(tokens && (tokens.refresh_token || tokens.access_token)),
      hasRefreshToken: Boolean(tokens?.refresh_token),
      missingScopes: tokens ? YOUTUBE_SCOPES.filter(scope => !granted.includes(scope)) : [],
      redirectUri: this.redirectUri()
    };
  }

  redirectUri() {
    return `http://localhost:${this.getPort()}/auth/youtube/callback`;
  }

  status() {
    const effective = this.effectiveTextProvider();
    const providers = this.textProviderIds().map(id => {
      const meta = this.textProviderMeta(id);
      const entry = this.textEntry(id);
      const envKey = this.envKeyFor(id);
      return {
        id,
        name: meta.name,
        models: meta.models,
        defaultModel: meta.defaultModel,
        keyUrl: KEY_URLS[id],
        covers: COVERS[id] || ['Scripts'],
        configured: Boolean(entry || envKey),
        source: entry ? 'dashboard' : (envKey ? 'environment' : null),
        envKey: envKey || null,
        maskedKey: entry ? mask(entry.apiKey) : '',
        model: entry?.model || meta.defaultModel,
        active: effective === id
      };
    });

    const services = SERVICES.map(service => {
      const stored = this.credentials[service.store] || {};
      const fields = service.fields.map(field => ({
        name: field.name,
        label: field.label,
        secret: field.secret,
        hint: field.hint || null,
        value: stored[field.name] ? (field.secret ? mask(stored[field.name]) : stored[field.name]) : ''
      }));
      return {
        id: service.id,
        name: service.name,
        group: service.group,
        description: service.description,
        keyUrl: service.keyUrl,
        testable: service.testable,
        fields,
        configured: service.fields.every(field => Boolean(stored[field.name]))
      };
    });

    const youtube = this.youtubeState();
    const textReady = providers.some(provider => provider.configured);
    const steps = [
      { id: 'text', label: 'AI provider for scripts', done: textReady, required: true },
      { id: 'youtube-client', label: 'YouTube credentials', done: youtube.clientConfigured, required: true },
      { id: 'youtube-signin', label: 'Sign in to YouTube', done: youtube.connected, required: true }
    ];
    return {
      textProviders: providers,
      activeTextProvider: effective,
      services,
      youtube,
      steps,
      ready: steps.every(step => !step.required || step.done)
    };
  }

  // ---- AI text providers ----------------------------------------------------------------

  saveTextProvider(input = {}) {
    return this.serialize(async () => {
      const meta = this.textProviderMeta(input.id);
      const existing = this.dedicatedEntry(meta.id);
      // Leaving the key blank keeps the saved one, so a model change does not need the key again.
      const apiKey = input.apiKey ? cleanSecret(input.apiKey, `${meta.name} API key`) : existing?.apiKey;
      if (!apiKey) throw new ConnectionError(`${meta.name} API key is required.`);
      const model = cleanModel(input.model, existing?.model || meta.defaultModel);
      this.setTextEntry(meta.id, { apiKey, model });
      const hadActive = Boolean(this.credentials.textProvider && this.textEntry(this.credentials.textProvider));
      if (input.makeActive !== false || !hadActive) this.credentials.textProvider = meta.id;
      this.syncActiveProvider();
      await this.persist();
      return { reload: await this.afterChange() };
    });
  }

  removeTextProvider(id) {
    return this.serialize(async () => {
      const meta = this.textProviderMeta(id);
      this.clearTextEntry(meta.id);
      this.syncActiveProvider();
      await this.persist();
      return { reload: await this.afterChange() };
    });
  }

  setActiveTextProvider(id) {
    return this.serialize(async () => {
      const meta = this.textProviderMeta(id);
      if (!this.textEntry(meta.id)) {
        throw new ConnectionError(`Save a ${meta.name} key first. A key set in .env cannot be selected here.`, 409);
      }
      this.credentials.textProvider = meta.id;
      this.syncActiveProvider();
      await this.persist();
      return { reload: await this.afterChange() };
    });
  }

  async testTextProvider(id, override = {}) {
    const meta = this.textProviderMeta(id);
    const entry = this.textEntry(meta.id);
    const apiKey = override.apiKey ? cleanSecret(override.apiKey, `${meta.name} API key`) : (entry?.apiKey || process.env[meta.envKey]);
    if (!apiKey) throw new ConnectionError(`No ${meta.name} key is saved yet.`, 409);
    const model = cleanModel(override.model, entry?.model || meta.defaultModel);
    const started = Date.now();
    try {
      const service = AITextService.forProvider(meta.id, apiKey, model);
      // Thinking models spend some output tokens before answering, so leave headroom.
      const reply = await service.generateText('Reply with exactly READY.', { maxTokens: 256, temperature: 0 });
      if (!String(reply || '').trim()) throw new Error('The provider returned an empty reply.');
      return { ok: true, message: `${meta.name} answered using ${model}.`, durationMs: Date.now() - started };
    } catch (error) {
      return { ok: false, message: friendlyProviderError(error, meta.name, model, [apiKey]), durationMs: Date.now() - started };
    }
  }

  // ---- Narration and video services -----------------------------------------------------

  service(id) {
    const service = SERVICES.find(item => item.id === id);
    if (!service) throw new ConnectionError('Unknown service.', 404);
    return service;
  }

  saveService(id, input = {}) {
    return this.serialize(async () => {
      const service = this.service(id);
      const current = { ...(this.credentials[service.store] || {}) };
      const next = {};
      for (const field of service.fields) {
        const raw = input[field.name];
        if (raw === undefined || raw === '') {
          // Leaving a secret blank keeps the saved one, so editing a voice ID does not re-ask for the key.
          if (current[field.name]) { next[field.name] = current[field.name]; continue; }
          throw new ConnectionError(`${field.label} is required.`);
        }
        if (field.secret) next[field.name] = cleanSecret(raw, field.label);
        else {
          const value = String(raw).trim();
          if (field.pattern && !field.pattern.test(value)) throw new ConnectionError(`${field.label} is not in a valid format.`);
          next[field.name] = value;
        }
      }
      this.credentials[service.store] = next;
      await this.persist();
      return { reload: await this.afterChange() };
    });
  }

  removeService(id) {
    return this.serialize(async () => {
      const service = this.service(id);
      delete this.credentials[service.store];
      await this.persist();
      return { reload: await this.afterChange() };
    });
  }

  async testService(id) {
    const service = this.service(id);
    const stored = this.credentials[service.store];
    if (!stored || !service.fields.every(field => stored[field.name])) {
      throw new ConnectionError(`Save the ${service.name} details first.`, 409);
    }
    if (!service.testable) {
      return { ok: true, skipped: true, message: `${service.name} has no free check. It is verified when a paid probe runs from Readiness.` };
    }
    const secrets = Object.values(stored);
    const started = Date.now();
    try {
      if (id === 'elevenlabs') {
        const response = await this.fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(stored.voiceId)}`, {
          headers: { 'xi-api-key': stored.apiKey },
          signal: AbortSignal.timeout(15000)
        });
        if (response.status === 401) throw new Error('ElevenLabs rejected the API key.');
        if (response.status === 404 || response.status === 422) throw new Error('That Voice ID was not found in your ElevenLabs account.');
        if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status}.`);
        return { ok: true, message: 'ElevenLabs accepted the key and the voice exists.', durationMs: Date.now() - started };
      }
      if (id === 'seedance') {
        const response = await this.fetch('https://api.replicate.com/v1/account', {
          headers: { Authorization: `Bearer ${stored.apiKey}` },
          signal: AbortSignal.timeout(15000)
        });
        if (response.status === 401) throw new Error('Replicate rejected the API token.');
        if (!response.ok) throw new Error(`Replicate returned HTTP ${response.status}.`);
        return { ok: true, message: 'Replicate accepted the token.', durationMs: Date.now() - started };
      }
      return { ok: true, skipped: true, message: 'No check is available for this service.' };
    } catch (error) {
      return { ok: false, message: redact(error.message, secrets), durationMs: Date.now() - started };
    }
  }

  // ---- YouTube ----------------------------------------------------------------------------

  saveYouTubeClient(input = {}) {
    return this.serialize(async () => {
      const clientId = cleanSecret(input.clientId, 'Client ID');
      const existing = this.credentials.youtube || {};
      const clientSecret = input.clientSecret ? cleanSecret(input.clientSecret, 'Client secret') : existing.client_secret;
      if (!clientSecret) throw new ConnectionError('Client secret is required.');
      const changed = existing.client_id !== clientId || existing.client_secret !== clientSecret;
      this.credentials.youtube = {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [this.redirectUri()]
      };
      // Tokens belong to one OAuth client; a different client invalidates them.
      if (changed && this.cm.tokens?.youtube) {
        delete this.cm.tokens.youtube;
        await this.cm.saveTokens();
      }
      await this.persist();
      return { reload: await this.afterChange() };
    });
  }

  oauthClient() {
    const youtube = this.credentials.youtube;
    if (!youtube?.client_id || !youtube?.client_secret) {
      throw new ConnectionError('Save your YouTube client ID and secret first.', 409);
    }
    return new this.googleClient.auth.OAuth2(youtube.client_id, youtube.client_secret, this.redirectUri());
  }

  async startYouTubeAuth() {
    const client = this.oauthClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    for (const [key, value] of this.pendingAuth) {
      if (now - value.createdAt > 10 * 60 * 1000) this.pendingAuth.delete(key);
    }
    if (this.pendingAuth.size >= 20) this.pendingAuth.delete(this.pendingAuth.keys().next().value);
    this.pendingAuth.set(state, { verifier: codeVerifier, createdAt: now });
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: YOUTUBE_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
    return { url };
  }

  // Called by the browser redirect from Google. The state value ties it to a sign-in this app started.
  completeYouTubeAuth({ code, state, error } = {}) {
    return this.serialize(async () => {
      const pending = typeof state === 'string' ? this.pendingAuth.get(state) : null;
      if (pending) this.pendingAuth.delete(state);
      if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
        throw new ConnectionError('This sign-in link is not valid or has expired. Start again from Connections.', 400);
      }
      if (error) {
        throw new ConnectionError(error === 'access_denied'
          ? 'Google sign-in was cancelled or this Google account is not listed as a test user for your app.'
          : `Google returned an error: ${redact(error)}`);
      }
      if (typeof code !== 'string' || !code) throw new ConnectionError('Google did not return an authorization code.');
      const client = this.oauthClient();
      let tokens;
      try {
        ({ tokens } = await client.getToken({ code, codeVerifier: pending.verifier }));
      } catch (exchangeError) {
        throw new ConnectionError(`Google would not exchange the sign-in code: ${redact(exchangeError.message, [code])}`);
      }
      if (!tokens.refresh_token && !this.cm.tokens?.youtube?.refresh_token) {
        throw new ConnectionError('Google did not grant offline access. Remove this app at myaccount.google.com/permissions and sign in again.');
      }
      this.cm.tokens.youtube = { ...(this.cm.tokens.youtube || {}), ...tokens };
      await this.cm.saveTokens();
      const reload = await this.afterChange();
      const missingScopes = YOUTUBE_SCOPES.filter(scope => !String(tokens.scope || '').split(/\s+/).includes(scope));
      return { connected: true, missingScopes, reload };
    });
  }

  disconnectYouTube({ forgetClient = false } = {}) {
    return this.serialize(async () => {
      const tokens = this.cm.tokens?.youtube;
      if (tokens) {
        try {
          if (tokens.refresh_token || tokens.access_token) {
            await this.oauthClient().revokeToken(tokens.refresh_token || tokens.access_token);
          }
        } catch (error) {
          this.logger.warn(`Could not revoke the Google token: ${redact(error.message)}`);
        }
        delete this.cm.tokens.youtube;
        await this.cm.saveTokens();
      }
      if (forgetClient) {
        delete this.credentials.youtube;
        await this.persist();
      }
      return { reload: await this.afterChange() };
    });
  }

  async testYouTube() {
    const started = Date.now();
    try {
      const youtube = this.cm.getYouTubeClient();
      const response = await youtube.channels.list({ part: 'snippet', mine: true, maxResults: 1 });
      const channel = response.data?.items?.[0];
      if (!channel) {
        return { ok: false, message: 'Signed in, but this Google account has no YouTube channel.', durationMs: Date.now() - started };
      }
      return { ok: true, message: `Connected to ${channel.snippet?.title || 'your channel'}.`, channel: { id: channel.id, title: channel.snippet?.title || null }, durationMs: Date.now() - started };
    } catch (error) {
      return { ok: false, message: redact(error.message) || 'YouTube rejected the request.', durationMs: Date.now() - started };
    }
  }
}

module.exports = { ConnectionService, ConnectionError, SERVICES, YOUTUBE_SCOPES, mask, redact };
