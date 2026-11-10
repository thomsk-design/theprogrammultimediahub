// Talent audio input: listens to a USB interface (e.g. Zoom H2essential) for metering
// and voice detection. Nothing is recorded, stored or sent anywhere — the recorder
// keeps the real take. Audio is analysed in this browser only.
window.TalentAudio = (() => {
  const prefsKey = 'program-talent-audio-v1';
  const prefs = { deviceId: '', threshold: -50, floor: null, auto: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(prefsKey) || '{}')); } catch {}
  prefs.threshold = Math.min(-15, Math.max(-85, Number(prefs.threshold) || -50));
  prefs.auto = prefs.auto !== false;
  const savePrefs = () => { try { localStorage.setItem(prefsKey, JSON.stringify(prefs)); } catch {} };

  const HANG_MS = 450;        // keep "speaking" through short gaps between words
  const HOLD_MS = 1500;       // peak-hold marker
  const HOT_DB = -3;          // feed is running hot
  const AUTO_MARGIN = 10;     // auto mode: speech is this many dB above the room
  const RELEASE_DB = 4;       // hysteresis: stay "speaking" until this far below the trigger
  const listeners = new Set();
  const level = { connected: false, label: '', rms: -100, peak: -100, peakHold: -100, hot: false, voice: false, raw: false, floor: null, threshold: prefs.threshold };
  let ctx = null, stream = null, analyser = null, buf = null, frame = 0, source = null, silent = null, tapReady = null;
  let lastVoice = 0, peakAt = 0, hotUntil = 0, calibration = null;

  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioContext);
  const emit = (type, detail) => { for (const fn of listeners) { try { fn(type, detail); } catch (e) { console.error(e); } } };
  const toDb = v => v > 0 ? Math.max(-100, 20 * Math.log10(v)) : -100;

  async function devices() {
    if (!supported()) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  }

  function loop() {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) { const s = buf[i]; sum += s * s; const a = Math.abs(s); if (a > peak) peak = a; }
    const now = performance.now();
    const rmsDb = toDb(Math.sqrt(sum / buf.length)), peakDb = toDb(peak);
    level.rms = rmsDb > level.rms ? rmsDb : Math.max(rmsDb, level.rms - 1.2);  // fast attack, gentle release
    level.peak = peakDb;
    if (peakDb >= level.peakHold || now - peakAt > HOLD_MS) { level.peakHold = peakDb; peakAt = now; }
    if (peakDb >= HOT_DB) hotUntil = now + 2000;
    level.hot = now < hotUntil;
    // Track the room's noise floor: drop quickly to quiet moments, creep up slowly.
    if (rmsDb > -100) {
      if (level.floor === null) level.floor = rmsDb;
      else if (rmsDb < level.floor) level.floor += (rmsDb - level.floor) * 0.3;
      else level.floor += Math.min(rmsDb - level.floor, 0.015);
    }
    level.threshold = prefs.auto && level.floor !== null ? Math.round(Math.min(-15, Math.max(-85, level.floor + AUTO_MARGIN))) : prefs.threshold;
    level.raw = rmsDb > level.threshold;
    if (level.raw || (level.voice && rmsDb > level.threshold - RELEASE_DB)) lastVoice = now;
    level.voice = now - lastVoice < HANG_MS;
    if (calibration) calibration.samples.push(rmsDb);
    emit('frame', level);
    frame = requestAnimationFrame(loop);
  }

  async function connect(deviceId = prefs.deviceId) {
    if (!supported()) throw new Error('This browser cannot access audio inputs.');
    disconnect(true);
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base });
    } catch (error) {
      if (!deviceId || error.name !== 'OverconstrainedError') throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: base }); // saved device unplugged: fall back
    }
    const track = stream.getAudioTracks()[0];
    // Run at the interface's own sample rate so backup recordings aren't resampled.
    const rate = track.getSettings().sampleRate;
    try { ctx = rate ? new AudioContext({ sampleRate: rate }) : new AudioContext(); } catch { ctx = new AudioContext(); }
    if (ctx.state === 'suspended') await ctx.resume();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    buf = new Float32Array(analyser.fftSize);
    source = ctx.createMediaStreamSource(stream);
    source.connect(analyser); // analyser only — never routed to speakers
    silent = ctx.createGain();
    silent.gain.value = 0;     // keeps the recorder running without making any sound
    silent.connect(ctx.destination);
    tapReady = null;
    track.onended = () => { disconnect(true); emit('lost'); };
    level.connected = true;
    level.label = track.label || 'Audio input';
    level.floor = prefs.floor;
    prefs.deviceId = track.getSettings().deviceId || deviceId || '';
    savePrefs();
    lastVoice = 0;
    frame = requestAnimationFrame(loop);
    emit('connected', level);
    return level;
  }

  function disconnect(silent = false) {
    cancelAnimationFrame(frame);
    if (stream) for (const t of stream.getTracks()) t.stop();
    if (ctx) ctx.close().catch(() => {});
    stream = ctx = analyser = source = silent = tapReady = null;
    calibration = null;
    Object.assign(level, { connected: false, rms: -100, peak: -100, peakHold: -100, hot: false, voice: false, raw: false, floor: null, threshold: prefs.threshold });
    if (!silent) emit('disconnected');
  }

  // Listen to room tone for a few seconds and set the speaking threshold above it.
  function calibrate(ms = 3000) {
    if (!level.connected) return Promise.reject(new Error('Connect a microphone first.'));
    return new Promise(resolve => {
      calibration = { samples: [] };
      setTimeout(() => {
        const samples = (calibration ? calibration.samples : []).filter(v => v > -100).sort((a, b) => a - b);
        calibration = null;
        const floor = samples.length ? samples[Math.floor(samples.length * 0.9)] : -70; // 90th percentile of room noise
        prefs.floor = Math.round(floor);
        level.floor = floor;
        prefs.threshold = Math.round(Math.min(-15, Math.max(-85, floor + AUTO_MARGIN)));
        savePrefs();
        emit('calibrated', { floor: prefs.floor, threshold: prefs.threshold });
        resolve({ floor: prefs.floor, threshold: prefs.threshold });
      }, ms);
    });
  }

  function setThreshold(db) { prefs.threshold = Math.min(-15, Math.max(-85, Number(db))); prefs.auto = false; savePrefs(); }
  function setAuto(on) { prefs.auto = !!on; if (!on && level.threshold) prefs.threshold = level.threshold; savePrefs(); }

  // ---- Backup recording: 24-bit WAV of the input, streamed to a target as it records ----
  const TAP = `class ProgramTap extends AudioWorkletProcessor {
    constructor() { super(); this.on = true; this.buf = []; this.n = 0;
      this.port.onmessage = e => { if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage('done'); } }; }
    flush() { if (!this.n) return; this.port.postMessage(this.buf); this.buf = []; this.n = 0; }
    process(inputs) { if (!this.on) return false; const input = inputs[0];
      if (input && input.length) { this.buf.push(input.map(ch => ch.slice())); this.n += input[0].length; if (this.n >= 9600) this.flush(); }
      return true; }
  }
  registerProcessor('program-tap', ProgramTap);`;
  function wavHeader(frames, rate, channels) {
    const bytes = 3, data = frames * channels * bytes, h = new DataView(new ArrayBuffer(44));
    const text = (o, t) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, t.charCodeAt(i)); };
    text(0, 'RIFF'); h.setUint32(4, 36 + data, true); text(8, 'WAVE'); text(12, 'fmt ');
    h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, channels, true); h.setUint32(24, rate, true);
    h.setUint32(28, rate * channels * bytes, true); h.setUint16(32, channels * bytes, true); h.setUint16(34, 24, true);
    text(36, 'data'); h.setUint32(40, data, true);
    return new Uint8Array(h.buffer);
  }
  function toPcm24(blocks, channels) {
    const frames = blocks.reduce((t, b) => t + b[0].length, 0), out = new Uint8Array(frames * channels * 3);
    let o = 0;
    for (const block of blocks) for (let i = 0; i < block[0].length; i++) for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, (block[c] || block[0])[i]));
      const v = Math.round(s < 0 ? s * 8388608 : s * 8388607);
      out[o++] = v & 255; out[o++] = (v >> 8) & 255; out[o++] = (v >> 16) & 255;
    }
    return { bytes: out, frames };
  }
  // target: { write(Uint8Array) -> Promise, finish(headerBytes) -> Promise }
  async function startRecording(target) {
    if (!level.connected || !ctx) throw new Error('Connect the microphone first.');
    if (!ctx.audioWorklet) throw new Error('This browser can’t record audio here.');
    if (!tapReady) { const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' })); tapReady = ctx.audioWorklet.addModule(url); }
    await tapReady;
    const channels = Math.max(1, Math.min(2, (stream.getAudioTracks()[0].getSettings().channelCount) || 1));
    const node = new AudioWorkletNode(ctx, 'program-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    const rate = ctx.sampleRate, myCtx = ctx;
    let frames = 0, pending = Promise.resolve(), failed = null, finished = null;
    const done = new Promise(resolve => { finished = resolve; });
    node.port.onmessage = event => {
      if (event.data === 'done') return finished();
      const pcm = toPcm24(event.data, channels);
      frames += pcm.frames;
      pending = pending.then(() => target.write(pcm.bytes)).catch(error => { failed = failed || error; });
    };
    source.connect(node);
    node.connect(silent);
    await target.write(new Uint8Array(44)); // header placeholder, filled in at the end
    return {
      rate, channels,
      get seconds() { return frames / rate; },
      async stop() {
        try { node.port.postMessage('stop'); } catch {}
        if (myCtx.state !== 'closed') await Promise.race([done, new Promise(r => setTimeout(r, 1000))]);
        try { source && source.disconnect(node); } catch {}
        try { node.disconnect(); } catch {}
        await pending;
        if (failed) throw failed;
        await target.finish(wavHeader(frames, rate, channels));
        return { seconds: frames / rate, frames, rate, channels };
      },
    };
  }

  if (supported() && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', () => emit('devices'));

  return {
    supported, devices, connect, disconnect, calibrate, setThreshold, setAuto, level, prefs,
    track: () => (stream ? stream.getAudioTracks()[0] : null),
    startRecording,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
