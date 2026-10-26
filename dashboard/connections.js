/* Connections: add keys, sign in to YouTube and prepare the video renderer, all from the dashboard.
   Depends on helpers from app.js (api, showToast, escapeHTML, refreshDashboard, switchView, ui). */
/* global ui, api, showToast, escapeHTML, refreshDashboard, switchView */
(() => {
  'use strict';

  const view = document.querySelector('#connections-view');
  if (!view) return;

  const state = {
    data: null,
    renderer: null,
    open: new Set(),
    results: {},
    busy: new Set(),
    signInTimer: null,
    signInDeadline: 0,
    rendererTimer: null,
    loadedOnce: false
  };

  const esc = value => escapeHTML(value);

  /* ---------- Loading and rendering ---------- */

  async function load({ force = false } = {}) {
    try {
      const response = await api('/api/connections');
      state.data = response.connections;
      state.renderer = response.renderer;
      state.loadedOnce = true;
      render({ force });
      manageRendererPolling();
    } catch (error) {
      view.querySelector('#conn-body').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    }
  }

  // Do not rebuild forms while someone is typing in one of them.
  function isEditing() {
    const el = document.activeElement;
    return Boolean(el && view.contains(el) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
  }

  function render({ force = false } = {}) {
    if (!state.data) return;
    renderChecklist();
    if (!force && isEditing()) return;
    const data = state.data;
    const ready = data.ready;
    const pill = view.querySelector('#connections-ready');
    pill.className = `status ${ready ? 'passed' : 'unverified'}`;
    pill.textContent = ready ? 'Ready to run' : 'Setup incomplete';

    const recommended = data.textProviders.filter(provider => ['gemini', 'openai'].includes(provider.id));
    const others = data.textProviders.filter(provider => !['gemini', 'openai'].includes(provider.id));
    const narration = data.services.filter(service => service.group === 'narration');
    const video = data.services.filter(service => service.group === 'video');

    view.querySelector('#conn-body').innerHTML = `
      <section class="conn-section" aria-labelledby="conn-h-text">
        <header><h3 id="conn-h-text">1 · AI provider for scripts</h3><p>One provider is enough. Gemini and OpenAI also cover images and narration. Pick which one writes scripts with <b>Use for scripts</b>.</p></header>
        <div class="conn-cards">${recommended.map(textCard).join('')}</div>
        <details class="conn-more" data-more="text-others" ${state.open.has('more:text-others') || (others.some(provider => provider.configured) && !recommended.some(provider => provider.configured)) ? 'open' : ''}>
          <summary>More script providers (${others.length})${others.find(provider => provider.active) ? ` · ${esc(others.find(provider => provider.active).name)} is active` : ''}</summary>
          <div class="conn-cards">${others.map(textCard).join('')}</div>
        </details>
      </section>

      <section class="conn-section" aria-labelledby="conn-h-yt">
        <header><h3 id="conn-h-yt">2 · YouTube</h3><p>Needed to read your channel, schedule and upload approved videos. Uploads stay private until you approve them.</p></header>
        <div class="conn-cards">${youtubeCard(data.youtube)}</div>
      </section>

      <section class="conn-section" aria-labelledby="conn-h-nar">
        <header><h3 id="conn-h-nar">3 · Narration <span class="conn-optional">optional</span></h3><p>Narration uses ElevenLabs first, then OpenAI, then Gemini. A video without working narration cannot be approved.</p></header>
        <div class="conn-cards">${narration.map(serviceCard).join('')}</div>
      </section>

      <section class="conn-section" aria-labelledby="conn-h-vid">
        <header><h3 id="conn-h-vid">4 · AI video <span class="conn-optional">optional</span></h3><p>The free local slideshow is the default. Add a provider only if you want generated clips, then choose it in Setup and set a paid-seconds cap. Gemini Omni uses your Gemini key above.</p></header>
        <div class="conn-cards">${video.map(serviceCard).join('')}</div>
      </section>

      <section class="conn-section" aria-labelledby="conn-h-rend">
        <header><h3 id="conn-h-rend">5 · Video renderer</h3><p>The slideshow is rendered with a browser engine on this computer.</p></header>
        <div class="conn-cards">${rendererCard()}</div>
      </section>

      <p class="callout">Keys are saved only on this computer, in <code>config/credentials.json</code>, and the dashboard never shows them again in full. Network settings such as <code>PORT</code>, <code>HOST</code> and <code>API_KEY</code> stay in <code>.env</code> on purpose.</p>`;
  }

  function renderChecklist() {
    const data = state.data;
    const requiredSteps = data.steps.map(step => ({ ...step, target: step.id === 'text' ? 'text' : 'yt' }));
    const providers = data.textProviders;
    const hasNarration = providers.some(p => ['openai', 'gemini'].includes(p.id) && p.configured)
      || data.services.some(service => service.id === 'elevenlabs' && service.configured);
    const hasImages = providers.some(p => ['openai', 'gemini'].includes(p.id) && p.configured);
    const optional = [
      { label: 'Narration', done: hasNarration, target: 'nar' },
      { label: 'Images and thumbnails', done: hasImages, target: 'text' },
      { label: 'Video renderer', done: Boolean(state.renderer?.ready), target: 'rend' }
    ];
    const done = requiredSteps.filter(step => step.done).length;
    const row = (label, ok, target, required) => `<li class="${ok ? 'done' : ''}">
      <span class="conn-tick" aria-hidden="true">${ok ? '✓' : ''}</span>
      <a href="#conn-h-${target}" data-jump="conn-h-${target}">${esc(label)}</a>
      <span class="conn-tag">${ok ? 'Done' : required ? 'Required' : 'Recommended'}</span></li>`;
    view.querySelector('#conn-checklist').innerHTML = `
      <div class="conn-check-head"><div><p class="eyebrow">SETUP PROGRESS</p><h3>${data.ready ? 'Everything required is connected.' : `${done} of ${requiredSteps.length} required steps done`}</h3></div>
      ${data.ready ? '<button class="button primary" data-go="readiness">Run readiness check</button>' : ''}</div>
      <ul class="conn-steps">${requiredSteps.map(step => row(step.label, step.done, step.target, true)).join('')}${optional.map(item => row(item.label, item.done, item.target, false)).join('')}</ul>`;
  }

  function chip(kind, text) {
    return `<span class="status ${kind}">${esc(text)}</span>`;
  }

  function providerChip(provider) {
    if (provider.active) return chip('passed', 'Active for scripts');
    if (provider.source === 'dashboard') return chip('approved', 'Saved');
    if (provider.source === 'environment') return chip('running', 'From .env');
    return chip('neutral', 'Not set');
  }

  function textCard(provider) {
    const key = `text:${provider.id}`;
    const open = state.open.has(key) || (!state.data.textProviders.some(p => p.configured) && provider.id === 'gemini');
    const options = [...new Set([provider.model, ...provider.models])]
      .map(model => `<option value="${esc(model)}" ${model === provider.model ? 'selected' : ''}>${esc(model)}</option>`).join('');
    const canActivate = provider.source === 'dashboard' && !provider.active;
    const placeholder = provider.maskedKey
      ? `${provider.maskedKey} saved. Paste a new key to replace`
      : provider.source === 'environment' ? `Using ${provider.envKey} from .env. Paste a key to override` : 'Paste your API key';
    return `<details class="conn-card" data-kind="text" data-id="${esc(provider.id)}" data-key="${esc(key)}" ${open ? 'open' : ''}>
      <summary><span class="conn-name">${esc(provider.name)}</span>
        <span class="conn-covers">${provider.covers.map(cover => `<i>${esc(cover)}</i>`).join('')}</span>${providerChip(provider)}</summary>
      <div class="conn-body">
        <div class="form-grid">
          <label><span>API key</span><input type="password" autocomplete="new-password" spellcheck="false" data-field="apiKey" placeholder="${esc(placeholder)}" aria-label="${esc(provider.name)} API key"></label>
          <label><span>Model</span><select data-field="model" aria-label="${esc(provider.name)} model">${options}</select></label>
        </div>
        <div class="conn-actions">
          <button class="button primary" data-action="save">Save &amp; test</button>
          <button class="button secondary" data-action="test" ${provider.configured ? '' : 'disabled'}>Test</button>
          ${canActivate ? '<button class="button secondary" data-action="activate">Use for scripts</button>' : ''}
          ${provider.source === 'dashboard' ? '<button class="button ghost danger-text" data-action="remove">Remove key</button>' : ''}
          <a class="conn-link" href="${esc(provider.keyUrl)}" target="_blank" rel="noopener noreferrer">Get a key ↗</a>
        </div>
        ${resultLine(key)}
      </div></details>`;
  }

  function serviceCard(service) {
    const key = `service:${service.id}`;
    const fields = service.fields.map(field => {
      const placeholder = field.secret
        ? (field.value ? `${field.value} saved. Paste a new value to replace` : `Paste ${field.label.toLowerCase()}`)
        : `Enter ${field.label.toLowerCase()}`;
      const value = field.secret ? '' : field.value;
      return `<label><span>${esc(field.label)}</span><input type="${field.secret ? 'password' : 'text'}" autocomplete="${field.secret ? 'new-password' : 'off'}" spellcheck="false" data-field="${esc(field.name)}" value="${esc(value)}" placeholder="${esc(placeholder)}">${field.hint ? `<small>${esc(field.hint)}</small>` : ''}</label>`;
    }).join('');
    return `<details class="conn-card" data-kind="service" data-id="${esc(service.id)}" data-key="${esc(key)}" ${state.open.has(key) ? 'open' : ''}>
      <summary><span class="conn-name">${esc(service.name)}</span>${service.configured ? chip('approved', 'Saved') : chip('neutral', 'Not set')}</summary>
      <div class="conn-body">
        <p class="conn-desc">${esc(service.description)}</p>
        <div class="form-grid">${fields}</div>
        <div class="conn-actions">
          <button class="button primary" data-action="save">${service.testable ? 'Save &amp; test' : 'Save'}</button>
          ${service.configured ? `<button class="button secondary" data-action="test">${service.testable ? 'Test' : 'Check'}</button>` : ''}
          ${service.configured ? '<button class="button ghost danger-text" data-action="remove">Remove</button>' : ''}
          <a class="conn-link" href="${esc(service.keyUrl)}" target="_blank" rel="noopener noreferrer">Get a key ↗</a>
        </div>
        ${resultLine(key)}
      </div></details>`;
  }

  function youtubeCard(youtube) {
    const key = 'youtube';
    const status = youtube.connected
      ? chip('passed', 'Connected')
      : youtube.clientConfigured ? chip('unverified', 'Sign-in needed') : chip('neutral', 'Not set');
    const scopeWarning = youtube.connected && youtube.missingScopes.length
      ? `<p class="conn-result bad" role="status">Some permissions were not granted (${youtube.missingScopes.length}). Uploads or analytics may be limited. Choose <b>Sign in again</b> and tick every box.</p>` : '';
    return `<details class="conn-card" data-kind="youtube" data-id="youtube" data-key="${key}" ${state.open.has(key) || !youtube.connected || youtube.missingScopes.length ? 'open' : ''}>
      <summary><span class="conn-name">YouTube channel</span><span class="conn-covers"><i>Read</i><i>Upload</i><i>Analytics</i></span>${status}</summary>
      <div class="conn-body">
        <details class="conn-help"><summary>How to get a Client ID and secret (about 5 minutes, free)</summary>
          <ol>
            <li>Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> and create a project.</li>
            <li>Under <b>APIs &amp; Services → Library</b>, enable <b>YouTube Data API v3</b> and <b>YouTube Analytics API</b>.</li>
            <li>Under <b>Google Auth Platform → Audience</b>, add the Google account that owns your channel as a <b>test user</b>.</li>
            <li>Under <b>Clients</b>, create an <b>OAuth client</b> of type <b>Desktop app</b> and copy the Client ID and secret here.</li>
          </ol>
          <p>While the app is in Testing mode, Google ends the sign-in after 7 days. Come back and choose <b>Sign in again</b>. If you used a <i>Web application</i> client instead, add this redirect URI to it: <code>${esc(youtube.redirectUri)}</code></p>
        </details>
        <div class="form-grid">
          <label><span>Client ID</span><input type="text" autocomplete="off" spellcheck="false" data-field="clientId" placeholder="123456-abc.apps.googleusercontent.com" aria-label="YouTube client ID"><small>${youtube.clientConfigured ? `Saved ending ${esc(youtube.clientId)}. Paste a new one to replace.` : 'Ends with .apps.googleusercontent.com'}</small></label>
          <label><span>Client secret</span><input type="password" autocomplete="new-password" spellcheck="false" data-field="clientSecret" placeholder="${youtube.clientConfigured ? 'Saved. Paste a new secret to replace' : 'GOCSPX-…'}" aria-label="YouTube client secret"></label>
        </div>
        <div class="conn-actions">
          <button class="button secondary" data-action="save-client">Save credentials</button>
          <button class="button primary" data-action="connect" ${youtube.clientConfigured ? '' : 'disabled'}>${youtube.connected ? 'Sign in again' : 'Sign in with Google'}</button>
          ${youtube.connected ? '<button class="button secondary" data-action="test">Test connection</button><button class="button ghost danger-text" data-action="disconnect">Disconnect</button>' : ''}
        </div>
        ${scopeWarning}
        ${resultLine(key)}
        <p class="conn-note" id="conn-signin-note" role="status" aria-live="polite"></p>
      </div></details>`;
  }

  function rendererCard() {
    const renderer = state.renderer || { ready: false, install: {} };
    const install = renderer.install || {};
    const running = install.status === 'running';
    const status = renderer.ready ? chip('passed', 'Ready') : running ? chip('running', 'Installing…') : chip('unverified', 'Not found');
    const detail = renderer.ready
      ? `Using ${esc(renderer.source || 'a browser')} on this computer.`
      : 'No browser engine was found. Install the renderer (about 150 MB, one time) or install Google Chrome.';
    return `<details class="conn-card" data-kind="renderer" data-id="renderer" data-key="renderer" ${state.open.has('renderer') || !renderer.ready ? 'open' : ''}>
      <summary><span class="conn-name">Slideshow renderer</span>${status}</summary>
      <div class="conn-body">
        <p class="conn-desc">${detail}</p>
        <div class="conn-actions">
          <button class="button ${renderer.ready ? 'secondary' : 'primary'}" data-action="install" ${running ? 'disabled' : ''}>${renderer.ready ? 'Reinstall renderer' : running ? 'Installing…' : 'Install renderer'}</button>
        </div>
        ${install.status === 'failed' ? `<p class="conn-result bad" role="status">${esc(install.error || 'The install failed.')} ${esc((install.log || '').split('\n').filter(Boolean).slice(-2).join(' '))}</p>` : ''}
        ${install.status === 'done' && renderer.ready ? '<p class="conn-result ok" role="status">Renderer installed.</p>' : ''}
      </div></details>`;
  }

  function resultLine(key) {
    const result = state.results[key];
    if (!result) return '<p class="conn-result" role="status" aria-live="polite"></p>';
    return `<p class="conn-result ${result.ok ? 'ok' : 'bad'}" role="status" aria-live="polite">${esc(result.message)}</p>`;
  }

  /* ---------- Actions ---------- */

  function fieldValues(card) {
    const values = {};
    card.querySelectorAll('[data-field]').forEach(input => {
      const value = input.value.trim();
      if (value !== '') values[input.dataset.field] = value;
    });
    return values;
  }

  function setBusy(card, busy, label) {
    card.querySelectorAll('button').forEach(button => {
      if (busy) {
        button.dataset.wasDisabled = button.disabled ? '1' : '';
        button.disabled = true;
      } else if (button.dataset.wasDisabled !== undefined) {
        button.disabled = button.dataset.wasDisabled === '1';
        delete button.dataset.wasDisabled;
      }
    });
    const status = card.querySelector('.conn-result');
    if (status && busy) {
      status.className = 'conn-result';
      status.textContent = label || 'Working…';
    }
  }

  function applyResponse(response) {
    if (response.connections) state.data = response.connections;
    if (response.renderer) state.renderer = response.renderer;
    // Agents were restarted with the new settings; refresh the rest of the dashboard promptly.
    if (typeof refreshDashboard === 'function') refreshDashboard(true);
  }

  function reloadNote(response) {
    const reload = response.reload;
    if (reload && reload.ok === false) return ` Saved, but the agents could not restart: ${reload.error}`;
    if (reload && reload.active) return ' The agents restarted with the new settings.';
    return '';
  }

  async function runAction(button) {
    const card = button.closest('[data-kind]');
    if (!card) return;
    const kind = card.dataset.kind;
    const id = card.dataset.id;
    const key = card.dataset.key;
    const action = button.dataset.action;
    const values = fieldValues(card);
    const json = body => JSON.stringify(body || {});
    const busyKey = `${key}:${action}`;
    if (state.busy.has(busyKey)) return;
    state.busy.add(busyKey);
    setBusy(card, true, action === 'save' ? 'Saving…' : action === 'connect' ? 'Opening Google…' : 'Working…');

    try {
      if (kind === 'text') {
        if (action === 'save') {
          const saved = await api(`/api/connections/text/${encodeURIComponent(id)}`, { method: 'PUT', body: json({ apiKey: values.apiKey, model: values.model }) });
          applyResponse(saved);
          const test = await api(`/api/connections/text/${encodeURIComponent(id)}/test`, { method: 'POST', body: json({}) });
          state.results[key] = test.result.ok
            ? { ok: true, message: `Saved. ${test.result.message}${reloadNote(saved)}` }
            : { ok: false, message: `Saved, but the check failed: ${test.result.message}` };
        } else if (action === 'test') {
          const test = await api(`/api/connections/text/${encodeURIComponent(id)}/test`, { method: 'POST', body: json({ apiKey: values.apiKey, model: values.model }) });
          state.results[key] = { ok: test.result.ok, message: test.result.message };
        } else if (action === 'activate') {
          const done = await api(`/api/connections/text/${encodeURIComponent(id)}/activate`, { method: 'POST', body: json() });
          applyResponse(done);
          state.results[key] = { ok: true, message: `Now writing scripts with this provider.${reloadNote(done)}` };
        } else if (action === 'remove') {
          if (!confirm('Remove this saved key from this computer?')) { state.busy.delete(busyKey); setBusy(card, false); return; }
          const done = await api(`/api/connections/text/${encodeURIComponent(id)}`, { method: 'DELETE' });
          applyResponse(done);
          state.results[key] = { ok: true, message: 'Key removed.' };
        }
      } else if (kind === 'service') {
        if (action === 'save') {
          const saved = await api(`/api/connections/services/${encodeURIComponent(id)}`, { method: 'PUT', body: json(values) });
          applyResponse(saved);
          const service = state.data.services.find(item => item.id === id);
          if (service?.testable) {
            const test = await api(`/api/connections/services/${encodeURIComponent(id)}/test`, { method: 'POST', body: json() });
            state.results[key] = test.result.ok ? { ok: true, message: `Saved. ${test.result.message}` } : { ok: false, message: `Saved, but the check failed: ${test.result.message}` };
          } else {
            state.results[key] = { ok: true, message: `Saved.${reloadNote(saved)}` };
          }
        } else if (action === 'test') {
          const test = await api(`/api/connections/services/${encodeURIComponent(id)}/test`, { method: 'POST', body: json() });
          state.results[key] = { ok: test.result.ok, message: test.result.message };
        } else if (action === 'remove') {
          if (!confirm('Remove these saved details from this computer?')) { state.busy.delete(busyKey); setBusy(card, false); return; }
          applyResponse(await api(`/api/connections/services/${encodeURIComponent(id)}`, { method: 'DELETE' }));
          state.results[key] = { ok: true, message: 'Removed.' };
        }
      } else if (kind === 'youtube') {
        if (action === 'save-client') {
          const saved = await api('/api/connections/youtube/client', { method: 'PUT', body: json(values) });
          applyResponse(saved);
          state.results[key] = { ok: true, message: 'Credentials saved. Now choose Sign in with Google.' };
        } else if (action === 'connect') {
          if (values.clientId || values.clientSecret) {
            applyResponse(await api('/api/connections/youtube/client', { method: 'PUT', body: json(values) }));
          }
          const { url } = await api('/api/connections/youtube/start', { method: 'POST', body: json() });
          // Passing "noopener" makes window.open return null even on success, so detach afterwards.
          const opened = window.open(url, '_blank');
          if (opened) { try { opened.opener = null; } catch (_error) { /* cross-origin already */ } }
          state.results[key] = { ok: true, message: opened ? 'Finish signing in on the Google tab. This page updates by itself.' : 'Your browser blocked the pop-up. Use the link below to continue.' };
          state.signInUrl = opened ? null : url;
          startSignInWatch();
        } else if (action === 'test') {
          const test = await api('/api/connections/youtube/test', { method: 'POST', body: json() });
          state.results[key] = { ok: test.result.ok, message: test.result.message };
        } else if (action === 'disconnect') {
          if (!confirm('Disconnect YouTube? Scheduled uploads will stop until you sign in again.')) { state.busy.delete(busyKey); setBusy(card, false); return; }
          applyResponse(await api('/api/connections/youtube/disconnect', { method: 'POST', body: json() }));
          state.results[key] = { ok: true, message: 'Disconnected from YouTube.' };
        }
      } else if (kind === 'renderer' && action === 'install') {
        const response = await api('/api/renderer/install', { method: 'POST', body: json() });
        state.renderer = response.renderer;
      }
    } catch (error) {
      state.results[key] = { ok: false, message: error.message };
    } finally {
      state.busy.delete(busyKey);
      state.open.add(key);
      render({ force: true });
      if (state.signInUrl && key === 'youtube') showSignInLink();
      manageRendererPolling();
    }
  }

  function showSignInLink() {
    const note = view.querySelector('#conn-signin-note');
    if (!note || !state.signInUrl) return;
    const link = document.createElement('a');
    link.href = state.signInUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Continue to Google ↗';
    note.replaceChildren(link);
  }

  /* ---------- Background watchers ---------- */

  function startSignInWatch() {
    clearInterval(state.signInTimer);
    state.signInDeadline = Date.now() + 5 * 60 * 1000;
    state.signInTimer = setInterval(async () => {
      if (Date.now() > state.signInDeadline) { clearInterval(state.signInTimer); return; }
      try {
        const response = await api('/api/connections');
        if (response.connections.youtube.connected && !state.data.youtube.connected) {
          clearInterval(state.signInTimer);
          state.data = response.connections;
          state.results.youtube = { ok: true, message: 'Signed in. Use Test connection to confirm your channel.' };
          showToast('YouTube connected.');
          render({ force: true });
          if (typeof refreshDashboard === 'function') refreshDashboard(true);
        }
      } catch (_error) { /* try again on the next tick */ }
    }, 2500);
  }

  function manageRendererPolling() {
    const running = state.renderer?.install?.status === 'running';
    if (running && !state.rendererTimer) {
      state.rendererTimer = setInterval(() => load({ force: true }), 2500);
    } else if (!running && state.rendererTimer) {
      clearInterval(state.rendererTimer);
      state.rendererTimer = null;
    }
  }

  /* ---------- Events ---------- */

  view.addEventListener('click', event => {
    const jump = event.target.closest('[data-jump]');
    if (jump) {
      event.preventDefault();
      const target = document.getElementById(jump.dataset.jump);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const button = event.target.closest('button[data-action]');
    if (button) runAction(button);
  });

  // Enter inside a field saves that card.
  view.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.target.matches('input[data-field]')) return;
    const card = event.target.closest('[data-kind]');
    const primary = card && card.querySelector('button.primary[data-action]:not([disabled])');
    if (primary) { event.preventDefault(); runAction(primary); }
  });

  // Remember which cards are open so a refresh does not collapse them.
  view.addEventListener('toggle', event => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    const key = el.dataset.key || (el.dataset.more ? `more:${el.dataset.more}` : null);
    if (!key) return;
    if (el.open) state.open.add(key); else state.open.delete(key);
  }, true);

  window.addEventListener('focus', () => {
    if (ui.currentView === 'connections') load();
  });

  window.loadConnections = () => load({ force: !isEditing() });

  // app.js runs first and may already have opened this view from the URL hash (for example the
  // redirect back from Google sign-in), before the loader above existed.
  if (view.classList.contains('active')) load({ force: true });

  // First visit while setup is incomplete: send people straight here.
  let firstStateSeen = false;
  const originalRender = window.renderDashboard;
  if (typeof originalRender === 'function') {
    window.renderDashboard = function () {
      originalRender.apply(this, arguments);
      if (!firstStateSeen) {
        firstStateSeen = true;
        if (ui.state?.system?.setupRequired && !location.hash && !sessionStorage.getItem('yaa_conn_seen')) {
          try { sessionStorage.setItem('yaa_conn_seen', '1'); } catch (_error) { /* storage may be blocked */ }
          switchView('connections');
        }
      }
    };
  }
})();
