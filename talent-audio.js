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
  let ctx = null, stream = null, analyser = null, buf = null, frame = 0;
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
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base });
    } catch (error) {
      if (!deviceId || error.name !== 'OverconstrainedError') throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: base }); // saved device unplugged: fall back
    }
    ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    buf = new Float32Array(analyser.fftSize);
    ctx.createMediaStreamSource(stream).connect(analyser); // analyser only — never routed to speakers
    const track = stream.getAudioTracks()[0];
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
    stream = ctx = analyser = null;
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

  if (supported() && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', () => emit('devices'));

  return {
    supported, devices, connect, disconnect, calibrate, setThreshold, setAuto, level, prefs,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
