// Vocal suite (Audio desk): de-esser + studio voice chain, processed in the browser.
// Clean-up high-pass → split-band de-esser → tone EQ → compressor → loudness → peak limiter.
// Processing runs in a Web Worker on the full file; A/B playback switches instantly.
(() => {
  // ---------- DSP (runs inside the worker) ----------
  function dsp() {
    function coeffs(type, f, fs, q, gainDb) {
      const A = Math.pow(10, (gainDb || 0) / 40), w = 2 * Math.PI * f / fs, cos = Math.cos(w), sin = Math.sin(w), alpha = sin / (2 * q);
      let b0, b1, b2, a0, a1, a2;
      if (type === 'hp') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
      else if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
      else if (type === 'peak') { b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; }
      else if (type === 'hshelf' || type === 'lshelf') {
        const s = 2 * Math.sqrt(A) * alpha, hi = type === 'hshelf' ? 1 : -1;
        b0 = A * ((A + 1) + hi * (A - 1) * cos + s); b1 = -2 * hi * A * ((A - 1) + hi * (A + 1) * cos); b2 = A * ((A + 1) + hi * (A - 1) * cos - s);
        a0 = (A + 1) - hi * (A - 1) * cos + s; a1 = 2 * hi * ((A - 1) - hi * (A + 1) * cos); a2 = (A + 1) - hi * (A - 1) * cos - s;
      }
      return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
    }
    function filter(x, c) {
      const y = new Float32Array(x.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      const [b0, b1, b2, a1, a2] = c;
      for (let i = 0; i < x.length; i++) { const v = x[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
      return y;
    }
    // Zero-phase (forward + backward) filtering: the band stays perfectly in step with the voice,
    // so subtracting it only ever removes energy.
    function filtfilt(x, c) { const y = filter(x, c).reverse(); return filter(y, c).reverse(); }
    const db = v => 20 * Math.log10(Math.max(v, 1e-9));
    const coef = (ms, fs) => Math.exp(-1 / (fs * ms / 1000));

    function loudness(chs, fs) {
      // ITU-R BS.1770-style integrated loudness (K-weighting, 400 ms blocks, gating).
      const k = chs.map(x => filter(filter(x, coeffs('hshelf', 1681, fs, 0.707, 4)), coeffs('hp', 38, fs, 0.5)));
      const block = Math.round(0.4 * fs), step = Math.round(0.1 * fs), powers = [];
      for (let s = 0; s + block <= k[0].length; s += step) {
        let sum = 0;
        for (const ch of k) { for (let i = s; i < s + block; i++) sum += ch[i] * ch[i]; }
        powers.push(sum / block);
      }
      const L = p => -0.691 + 10 * Math.log10(Math.max(p, 1e-12));
      let gated = powers.filter(p => L(p) > -70);
      if (!gated.length) return -70;
      const rel = L(gated.reduce((a, b) => a + b, 0) / gated.length) - 10;
      gated = gated.filter(p => L(p) > rel);
      return L(gated.reduce((a, b) => a + b, 0) / gated.length);
    }
    function peak(chs) { let p = 0; for (const ch of chs) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; } return p; }

    return function process(input, fs, P) {
      let chs = input.map(c => Float32Array.from(c));
      const n = chs[0].length, stats = { inLufs: loudness(chs, fs), inPeak: db(peak(chs)) };
      // 1. Clean-up high-pass
      if (P.hpOn) chs = chs.map(x => filter(filter(x, coeffs('hp', P.hpFreq, fs, 0.707)), coeffs('hp', P.hpFreq, fs, 0.707)));
      // 2. Split-band de-esser: detect sibilance relative to the whole voice; reduce only the highs.
      const grTrace = new Float32Array(Math.ceil(n / 512));
      let removed = new Float32Array(n), maxGr = 0, essEvents = 0;
      if (P.deOn) {
        const mono = new Float32Array(n);
        for (const ch of chs) for (let i = 0; i < n; i++) mono[i] += ch[i] / chs.length;
        const det = filter(filter(mono, coeffs('bp', P.deFreq, fs, 1.1)), coeffs('bp', P.deFreq, fs, 1.1));
        const highs = chs.map(x => filtfilt(x, coeffs('hp', P.deFreq * 0.75, fs, 0.707)));
        const atk = coef(0.5, fs), rel = coef(60, fs), gAtk = coef(1, fs), gRel = coef(45, fs);
        let eS = 0, eF = 0, gr = 0, wasActive = false;
        const thr = P.deThreshold, range = P.deRange;
        for (let i = 0; i < n; i++) {
          const s = Math.abs(det[i]), f = Math.abs(mono[i]);
          eS = s > eS ? atk * eS + (1 - atk) * s : rel * eS + (1 - rel) * s;
          eF = f > eF ? atk * eF + (1 - atk) * f : rel * eF + (1 - rel) * f;
          let target = 0;
          if (eF > 0.0015) { const over = db(eS / (eF + 1e-9)) - thr; if (over > 0) target = Math.min(range, over * 2); }
          gr = target > gr ? gAtk * gr + (1 - gAtk) * target : gRel * gr + (1 - gRel) * target;
          const cut = 1 - Math.pow(10, -gr / 20);
          for (let c = 0; c < chs.length; c++) { const r = cut * highs[c][i]; chs[c][i] -= r; if (c === 0) removed[i] = r; }
          if (gr > maxGr) maxGr = gr;
          const active = gr > 2; if (active && !wasActive) essEvents++; wasActive = active;
          const t = i >> 9; if (gr > grTrace[t]) grTrace[t] = gr;
        }
      }
      stats.maxGr = maxGr; stats.essEvents = essEvents;
      // 3. Tone: mud cut, presence, air
      if (P.toneOn) {
        const eq = [['peak', 250, 1.0, -P.mud], ['peak', 3500, 0.9, P.presence], ['hshelf', 12000, 0.707, P.air]].filter(e => e[3]);
        chs = chs.map(x => eq.reduce((y, e) => filter(y, coeffs(e[0], e[1], fs, e[2], e[3])), x));
      }
      // 4. Compressor: RMS detector, threshold set relative to the voice's own average loudness,
      //    so it only tucks in the louder syllables (a few dB) regardless of recording level.
      if (P.compOn) {
        const [rel, ratio] = { gentle: [3, 2], medium: [0, 2.5], strong: [-3, 3.5] }[P.comp] || [0, 2.5];
        const level = loudness(chs, fs), thr = level + rel, knee = 6, atk = coef(10, fs), relc = coef(150, fs), rmsC = coef(15, fs);
        let ms = 0, red = 0;
        for (let i = 0; i < n; i++) {
          let a = 0; for (const ch of chs) a += ch[i] * ch[i]; a /= chs.length;
          ms = rmsC * ms + (1 - rmsC) * a;
          const over = 10 * Math.log10(ms + 1e-12) + 3 - thr; // +3 ≈ RMS→loudness offset for speech
          let target = 0;
          if (over > knee / 2) target = over - over / ratio;
          else if (over > -knee / 2) { const o = over + knee / 2; target = (1 - 1 / ratio) * o * o / (2 * knee); }
          red = target > red ? atk * red + (1 - atk) * target : relc * red + (1 - relc) * target;
          const g = Math.pow(10, -red / 20);
          for (const ch of chs) ch[i] *= g;
        }
      }
      // 5. Loudness to target, then 6. peak limiter (look-ahead style two-pass gain smoothing)
      const now = loudness(chs, fs), gain = Math.pow(10, (P.target - now) / 20);
      for (const ch of chs) for (let i = 0; i < n; i++) ch[i] *= gain;
      const ceil = Math.pow(10, (P.ceiling - 0.5) / 20), g = new Float32Array(n);
      for (let i = 0; i < n; i++) { let a = 0; for (const ch of chs) a = Math.max(a, Math.abs(ch[i])); g[i] = a > ceil ? ceil / a : 1; }
      const relStep = 1 / (fs * 0.08), atkStep = 1 / (fs * 0.0015);
      for (let i = 1; i < n; i++) g[i] = Math.min(g[i], g[i - 1] + relStep);
      for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + atkStep);
      for (const ch of chs) for (let i = 0; i < n; i++) ch[i] *= g[i];
      stats.outLufs = loudness(chs, fs); stats.outPeak = db(peak(chs));
      return { chs, removed, grTrace, stats };
    };
  }
  const workerSrc = `const process = (${dsp.toString()})();
    onmessage = e => { const { id, input, fs, params } = e.data; const r = process(input, fs, params);
      postMessage({ id, chs: r.chs, removed: r.removed, grTrace: r.grTrace, stats: r.stats }, [...r.chs.map(c => c.buffer), r.removed.buffer, r.grTrace.buffer]); };`;

  // ---------- Presets ----------
  const PRESETS = {
    studio: { name: 'Studio voice', hpOn: true, hpFreq: 80, deOn: true, deFreq: 6500, deThreshold: -14, deRange: 8, toneOn: true, mud: 2, presence: 1.5, air: 2, compOn: true, comp: 'medium', target: -18, ceiling: -1.5 },
    adam: { name: 'Adam · strong esses', hpOn: true, hpFreq: 80, deOn: true, deFreq: 6000, deThreshold: -18, deRange: 12, toneOn: true, mud: 2, presence: 1, air: 0.5, compOn: true, comp: 'medium', target: -18, ceiling: -1.5 },
    light: { name: 'Light touch', hpOn: true, hpFreq: 70, deOn: true, deFreq: 7000, deThreshold: -10, deRange: 5, toneOn: false, mud: 0, presence: 0, air: 0, compOn: true, comp: 'gentle', target: -18, ceiling: -1.5 },
  };
  const KEY = 'program-vocal-suite-v1';
  let params = { ...PRESETS.studio };
  try { Object.assign(params, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(params)); } catch {} };

  // ---------- State ----------
  let ctx = null, worker = null, jobId = 0, file = null, original = null, processed = null, removedBuf = null, grTrace = null, stats = null;
  let mode = 'B', source = null, startedAt = 0, offset = 0, playing = false, raf = 0, rerun = 0, busy = false;
  const $v = sel => document.querySelector('.vocal-suite ' + sel);
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function panel() {
    const p = params, sel = (name, opts) => `<select data-v="${name}">${opts.map(([v, l]) => `<option value="${v}" ${String(p[name]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const range = (name, label, min, max, step, unit) => `<label class="vs-range">${label}<input type="range" data-v="${name}" min="${min}" max="${max}" step="${step}" value="${p[name]}"><output data-out="${name}" data-unit="${unit}">${p[name]}${unit}</output></label>`;
    const toggle = (name, label) => `<label class="vs-toggle"><input type="checkbox" data-v="${name}" ${p[name] ? 'checked' : ''}> ${label}</label>`;
    return `<section class="panel vocal-suite"><div class="panel-head"><h2>Vocal suite</h2><span class="tag blue">Preview</span></div><div class="panel-body">
      <div class="vs-load" data-vs-drop><div><b>Bring in a vocal</b><p class="small muted">Drop a WAV or MP3 here, or choose one. It stays on this computer while you work.</p></div><button class="btn primary" data-vs-choose>Choose audio…</button><input type="file" accept="audio/*,.wav,.mp3,.m4a,.aif,.aiff,.flac" data-vs-file hidden></div>
      <div class="vs-work" hidden>
        <div class="vs-transport"><button class="btn primary" data-vs-play>▶ Play</button>
          <div class="vs-ab" role="group" aria-label="Listen to"><button data-vs-mode="A">Original</button><button data-vs-mode="B" class="active">Processed</button><button data-vs-mode="S" title="Hear only what the de-esser removes">Ess only</button></div>
          <span class="vs-time"><output data-vs-time>00:00</output> / <output data-vs-dur>00:00</output></span><span class="vs-file" data-vs-name></span><span class="vs-busy" data-vs-busy hidden>Processing…</span></div>
        <canvas class="vs-wave" data-vs-wave height="120"></canvas>
        <p class="small muted vs-legend"><span class="vs-key"></span> Ess reduction · click the waveform to jump</p>
        <div class="vs-grid">
          <section><h3>Preset</h3>${sel('preset', Object.entries(PRESETS).map(([k, v]) => [k, v.name]).concat([['custom', 'Custom']]))}<p class="small muted">Changes are remembered on this computer.</p></section>
          <section><h3>${toggle('deOn', 'De-esser')}</h3>${range('deFreq', 'Frequency', 3500, 10000, 100, ' Hz')}${range('deThreshold', 'Sensitivity', -30, -4, 1, ' dB')}${range('deRange', 'Max reduction', 2, 18, 1, ' dB')}<div class="vs-gr"><span>Reduction</span><div><i data-vs-gr></i></div><output data-vs-grv>0 dB</output></div></section>
          <section><h3>${toggle('toneOn', 'Tone')}</h3>${range('mud', 'Mud cut (250 Hz)', 0, 6, 0.5, ' dB')}${range('presence', 'Presence (3.5 kHz)', -3, 4, 0.5, ' dB')}${range('air', 'Air (12 kHz)', -2, 4, 0.5, ' dB')}</section>
          <section><h3>${toggle('compOn', 'Compressor')}</h3><label class="vs-range">Amount ${sel('comp', [['gentle', 'Gentle'], ['medium', 'Medium'], ['strong', 'Strong']])}</label><h3 class="mt">${toggle('hpOn', 'Clean-up high-pass')}</h3>${range('hpFreq', 'Cut below', 40, 200, 5, ' Hz')}</section>
          <section><h3>Finish</h3><label class="vs-range">Loudness ${sel('target', [[-16, '−16 LUFS (podcast)'], [-18, '−18 LUFS (house, provisional)'], [-19, '−19 LUFS'], [-23, '−23 LUFS (broadcast)']])}</label><label class="vs-range">Peak ceiling ${sel('ceiling', [[-1, '−1 dB'], [-1.5, '−1.5 dB'], [-2, '−2 dB']])}</label><dl class="vs-stats" data-vs-stats></dl></section>
        </div>
        <div class="row mt"><button class="btn" data-vs-download>Download WAV ↓</button><button class="btn" data-vs-drive hidden>Save to Google Drive (02_Working)</button><button class="text-link" data-vs-new>Load a different file</button></div>
        <p class="small muted mt">Auphonic’s de-esser lives inside Voice AutoEQ (automatic, no strength control). Use this suite when you want hands-on control, then send the result to Auphonic for leveling if you like.</p>
      </div></div></section>`;
  }

  function ensureWorker() {
    if (!worker) worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
    return worker;
  }
  function run() {
    if (!original) return;
    const id = ++jobId;
    busy = true; showBusy();
    const input = []; for (let c = 0; c < original.numberOfChannels; c++) input.push(original.getChannelData(c).slice());
    ensureWorker().onmessage = e => {
      if (e.data.id !== jobId) return;
      const { chs, removed, stats: st } = e.data;
      processed = ctx.createBuffer(chs.length, chs[0].length, original.sampleRate);
      chs.forEach((c, i) => processed.copyToChannel(c, i));
      removedBuf = ctx.createBuffer(1, removed.length, original.sampleRate);
      const boost = new Float32Array(removed.length); for (let i = 0; i < removed.length; i++) boost[i] = removed[i] * 3; // easier to hear
      removedBuf.copyToChannel(boost, 0);
      grTrace = e.data.grTrace; stats = st; busy = false; showBusy();
      drawWave(); showStats();
      if (playing && mode !== 'A') { const t = position(); stopSource(); startAt(t); }
    };
    worker.postMessage({ id, input, fs: original.sampleRate, params }, input.map(c => c.buffer));
  }
  const schedule = () => { clearTimeout(rerun); rerun = setTimeout(run, 300); };

  async function load(f) {
    file = f;
    let rate = 48000;
    try { const head = new DataView(await f.slice(0, 64).arrayBuffer()); if (head.getUint32(0, false) === 0x52494646) rate = head.getUint32(24, true) || rate; } catch {}
    if (ctx) { try { ctx.close(); } catch {} }
    try { ctx = new AudioContext({ sampleRate: rate }); } catch { ctx = new AudioContext(); }
    $v('[data-vs-name]').textContent = 'Decoding…';
    try { original = await ctx.decodeAudioData(await f.arrayBuffer()); }
    catch { toast('That file couldn’t be opened. Try a WAV or MP3.'); $v('[data-vs-name]').textContent = ''; return; }
    stopSource(); offset = 0; processed = null;
    $v('.vs-load').hidden = true; $v('.vs-work').hidden = false;
    $v('[data-vs-name]').textContent = f.name;
    $v('[data-vs-dur]').textContent = fmt(original.duration);
    $v('[data-vs-drive]').hidden = !(window.HubDrive && HubDrive.connected());
    drawWave(); run();
  }

  // ---------- Playback ----------
  const bufferFor = m => (m === 'A' ? original : m === 'S' ? removedBuf : processed) || original;
  const position = () => (playing ? Math.min(offset + ctx.currentTime - startedAt, original.duration) : offset);
  function startAt(t) {
    source = ctx.createBufferSource();
    source.buffer = bufferFor(mode);
    source.connect(ctx.destination);
    source.onended = () => { if (source && source._mine && position() >= original.duration - 0.05) { playing = false; offset = 0; ui(); } };
    source._mine = true;
    ctx.resume();
    source.start(0, Math.max(0, Math.min(t, original.duration - 0.01)));
    startedAt = ctx.currentTime; offset = t; playing = true;
    tick();
  }
  function stopSource() { if (source) { source._mine = false; try { source.stop(); } catch {} source.disconnect(); source = null; } }
  function toggle() {
    if (!original) return;
    if (playing) { offset = position(); stopSource(); playing = false; } else startAt(offset);
    ui();
  }
  function tick() {
    cancelAnimationFrame(raf);
    const step = () => {
      if (!document.querySelector('.vocal-suite')) { stopSource(); playing = false; return; }
      $v('[data-vs-time]').textContent = fmt(position());
      if (grTrace) {
        const i = Math.floor(position() * original.sampleRate / 512), g = grTrace[i] || 0;
        $v('[data-vs-gr]').style.width = `${Math.min(100, g / Math.max(1, params.deRange) * 100)}%`;
        $v('[data-vs-grv]').textContent = `−${g.toFixed(1)} dB`;
      }
      drawCursor();
      if (playing) raf = requestAnimationFrame(step);
    };
    step();
  }
  function ui() {
    $v('[data-vs-play]').textContent = playing ? '❚❚ Pause' : '▶ Play';
    document.querySelectorAll('.vocal-suite [data-vs-mode]').forEach(b => b.classList.toggle('active', b.dataset.vsMode === mode));
  }

  // ---------- Drawing ----------
  let peaks = null;
  function drawWave() {
    const cv = $v('[data-vs-wave]');
    if (!cv || !original) return;
    const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = 120 * devicePixelRatio, g = cv.getContext('2d');
    const src = (processed || original).getChannelData(0), per = Math.max(1, Math.floor(src.length / w));
    peaks = new Float32Array(w);
    for (let x = 0; x < w; x++) { let m = 0; for (let i = x * per, e = Math.min(src.length, i + per); i < e; i++) { const a = Math.abs(src[i]); if (a > m) m = a; } peaks[x] = m; }
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(160,155,145,.55)';
    for (let x = 0; x < w; x++) { const a = Math.min(1, peaks[x]) * (h * 0.42); g.fillRect(x, h / 2 - a, 1, a * 2 || 1); }
    if (grTrace) {
      g.fillStyle = 'rgba(224,112,79,.85)';
      const perT = grTrace.length / w;
      for (let x = 0; x < w; x++) { let m = 0; for (let i = Math.floor(x * perT); i < Math.floor((x + 1) * perT); i++) m = Math.max(m, grTrace[i] || 0); if (m > 1) g.fillRect(x, h - Math.min(h * 0.3, m * 2 * devicePixelRatio), 1, h); }
    }
    cv._base = g.getImageData(0, 0, w, h);
    drawCursor();
  }
  function drawCursor() {
    const cv = $v('[data-vs-wave]');
    if (!cv || !cv._base || !original) return;
    const g = cv.getContext('2d'); g.putImageData(cv._base, 0, 0);
    const x = Math.round(position() / original.duration * cv.width);
    g.fillStyle = '#f4c144'; g.fillRect(x, 0, 2 * devicePixelRatio, cv.height);
  }
  function showStats() {
    if (!stats) return;
    const f = v => (v <= -69 ? '—' : v.toFixed(1));
    $v('[data-vs-stats]').innerHTML = `<dt>In</dt><dd>${f(stats.inLufs)} LUFS · peak ${f(stats.inPeak)} dB</dd><dt>Out</dt><dd>${f(stats.outLufs)} LUFS · peak ${f(stats.outPeak)} dB</dd><dt>Esses</dt><dd>${stats.essEvents} tamed · up to −${stats.maxGr.toFixed(1)} dB</dd>`;
  }
  function showBusy() { const b = $v('[data-vs-busy]'); if (b) b.hidden = !busy; }

  // ---------- Export ----------
  function wav(buffer) {
    const ch = buffer.numberOfChannels, n = buffer.length, rate = buffer.sampleRate, data = new Uint8Array(44 + n * ch * 3), v = new DataView(data.buffer);
    const s = (o, t) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 3, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 3, true); v.setUint16(32, ch * 3, true); v.setUint16(34, 24, true); s(36, 'data'); v.setUint32(40, n * ch * 3, true);
    const chans = [...Array(ch)].map((_, c) => buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const x = Math.max(-1, Math.min(1, chans[c][i])), q = Math.round(x < 0 ? x * 8388608 : x * 8388607); data[o++] = q & 255; data[o++] = (q >> 8) & 255; data[o++] = (q >> 16) & 255; }
    return new Blob([data], { type: 'audio/wav' });
  }
  const outName = () => (file ? file.name.replace(/\.[^.]+$/, '') : 'vocal') + '_vocal-suite.wav';

  // ---------- Wiring ----------
  function setParam(name, raw) {
    const el = $v(`[data-v="${name}"]`);
    let value = el.type === 'checkbox' ? el.checked : el.type === 'range' || /^-?\d/.test(raw) ? Number(raw) : raw;
    if (name === 'preset') {
      if (PRESETS[raw]) { params = { ...PRESETS[raw], preset: raw }; keep(); reRender(); schedule(); }
      return;
    }
    params[name] = value; params.preset = 'custom';
    const presetSel = $v('[data-v="preset"]'); if (presetSel) presetSel.value = 'custom';
    const out = $v(`[data-out="${name}"]`); if (out) out.textContent = value + out.dataset.unit;
    keep(); schedule();
  }
  function reRender() {
    const old = document.querySelector('.vocal-suite');
    if (!old) return;
    const wrap = document.createElement('div'); wrap.innerHTML = panel();
    const fresh = wrap.firstElementChild;
    if (original) { fresh.querySelector('.vs-load').hidden = true; fresh.querySelector('.vs-work').hidden = false; }
    old.replaceWith(fresh);
    if (original) { $v('[data-vs-name]').textContent = file.name; $v('[data-vs-dur]').textContent = fmt(original.duration); $v('[data-vs-drive]').hidden = !(window.HubDrive && HubDrive.connected()); drawWave(); showStats(); ui(); }
  }
  document.addEventListener('input', e => { const el = e.target.closest('.vocal-suite [data-v]'); if (el) setParam(el.dataset.v, el.value); });
  document.addEventListener('change', e => {
    const el = e.target.closest('.vocal-suite [data-v]'); if (el && el.tagName === 'SELECT') setParam(el.dataset.v, el.value);
    if (e.target.matches('.vocal-suite [data-vs-file]') && e.target.files[0]) load(e.target.files[0]);
  });
  document.addEventListener('click', async e => {
    const t = e.target.closest('.vocal-suite button, .vocal-suite canvas');
    if (!t) return;
    if (t.dataset.vsChoose !== undefined) $v('[data-vs-file]').click();
    else if (t.dataset.vsPlay !== undefined) toggle();
    else if (t.dataset.vsMode) { const was = playing ? position() : offset; mode = t.dataset.vsMode; if (playing) { stopSource(); startAt(was); } ui(); }
    else if (t.matches('[data-vs-wave]') && original) { const r = t.getBoundingClientRect(), at = (e.clientX - r.left) / r.width * original.duration; if (playing) { stopSource(); startAt(at); } else { offset = at; tick(); } }
    else if (t.dataset.vsDownload !== undefined && processed) {
      const url = URL.createObjectURL(wav(processed)), a = document.createElement('a'); a.href = url; a.download = outName(); a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else if (t.dataset.vsDrive !== undefined && processed) {
      t.disabled = true; t.textContent = 'Uploading… 0%';
      try {
        const f = await HubDrive.upload(wav(processed), { name: outName(), type: 'audio/wav', folder: '02_Working', onProgress: p => { t.textContent = `Uploading… ${Math.round(p * 100)}%`; } });
        HubDrive.addFile(f, { source: 'Vocal suite' }); toast('Saved to Google Drive · 02_Working'); t.textContent = '✓ Saved to Google Drive';
      } catch (err) { toast('Couldn’t save to Drive: ' + err.message); t.textContent = 'Save to Google Drive (02_Working)'; t.disabled = false; }
    } else if (t.dataset.vsNew !== undefined) { stopSource(); playing = false; original = processed = null; $v('.vs-load').hidden = false; $v('.vs-work').hidden = true; $v('[data-vs-file]').value = ''; }
  });
  document.addEventListener('dragover', e => { const z = e.target.closest('.vocal-suite [data-vs-drop]'); if (z) { e.preventDefault(); z.classList.add('drag'); } });
  document.addEventListener('dragleave', e => { const z = e.target.closest('.vocal-suite [data-vs-drop]'); if (z) z.classList.remove('drag'); });
  document.addEventListener('drop', e => { const z = e.target.closest('.vocal-suite [data-vs-drop]'); if (z) { e.preventDefault(); z.classList.remove('drag'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); } });
  document.addEventListener('keydown', e => { if (e.code === 'Space' && document.querySelector('.vocal-suite .vs-work:not([hidden])') && !e.target.matches('input,textarea,select,button') && !document.querySelector('dialog[open]')) { e.preventDefault(); toggle(); } });

  // Put the suite at the top of the Audio desk (production view only).
  const originalRender = window.render;
  window.render = function () {
    originalRender();
    if (location.hash !== '#processing' || demoRole !== 'production') { if (playing) { stopSource(); playing = false; } return; }
    const main = document.getElementById('main'), headEl = main && main.querySelector('.page-head');
    if (!headEl || main.querySelector('.vocal-suite')) return;
    const wrap = document.createElement('div'); wrap.innerHTML = panel();
    headEl.after(wrap.firstElementChild);
    if (original) reRender();
  };
  window.addEventListener('resize', () => { if (original && document.querySelector('.vocal-suite')) drawWave(); });
})();
