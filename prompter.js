/* Video prompter · The Program
   Auto-scrolls at Adam's measured pace (from 18 Program recordings, ~1 hour of speech):
   each word takes 0.18 s + 0.04 s per letter; pauses of 0.13 s at a comma, 0.54 s at "…",
   1.16 s after a sentence, 1.26 s after a question, 0.3 s between paragraphs.
   Scripted pauses hold for their length plus 1 s, as Adam held them in the recordings.
   Optional voice sync lines the prompter up with him at the end of every sentence. */
(() => {
  const PACE = { word: 0.18, letter: 0.04, comma: 0.13, ellipsis: 0.54, sentence: 1.16, question: 1.26, paragraph: 0.3, cueExtra: 1.0 };
  const CUE = /\[\s*(silence|pause|breath)\b[^\]\d]*(\d+(?:\.\d+)?)?[^\]]*\]/gi;
  const CUE_DEFAULT = { silence: 3, pause: 2, breath: 1 };
  const KEY = 'program-video-prompter-v1';
  const $ = id => document.getElementById(id);
  const ui = { script: $('script'), mirror: $('mirror'), sync: $('sync'), pace: $('pace'), size: $('size'), line: $('line'), countdown: $('countdown'), gong: $('gong'), gongVol: $('gongVol') };

  // ---------- settings ----------
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();
  ui.script.value = saved.script || '';
  for (const k of ['pace', 'size', 'line', 'countdown', 'gongVol']) if (saved[k]) ui[k].value = saved[k];
  if (typeof saved.gong === 'boolean') ui.gong.checked = saved.gong;
  if (typeof saved.mirror === 'boolean') ui.mirror.checked = saved.mirror;
  if (typeof saved.sync === 'boolean') ui.sync.checked = saved.sync;
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ script: ui.script.value, pace: ui.pace.value, size: ui.size.value, line: ui.line.value, countdown: ui.countdown.value, mirror: ui.mirror.checked, sync: ui.sync.checked, gong: ui.gong.checked, gongVol: ui.gongVol.value }));
      $('saved').textContent = 'Saved on this iPad.';
    } catch { $('saved').textContent = 'Could not save. Keep a copy of the script.'; }
  }
  function labels() {
    $('paceOut').textContent = `${ui.pace.value}%`;
    $('sizeOut').textContent = `${ui.size.value} px`;
    $('lineOut').textContent = `${ui.line.value}% from top`;
    $('cdOut').textContent = `${ui.countdown.value} s`;
    $('gongOut').textContent = ui.gong.checked ? `${ui.gongVol.value}%` : 'Off';
    ui.gongVol.disabled = $('gongTest').disabled = !ui.gong.checked;
    const s = Math.round(model(parse(ui.script.value)).total);
    $('estimate').textContent = ui.script.value.trim() ? `About ${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s at Adam’s pace` : '—';
  }

  // ---------- script → tokens ----------
  // Returns paragraphs: [{ gap: bool, items: [{ k:'w', text, pause, sync } | { k:'t', text } | { k:'cue', kind, secs, text }] }]
  function parse(src) {
    const paras = [];
    let gap = false;
    for (const raw of src.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (!line) { gap = paras.length > 0; continue; }
      const items = [];
      let last = 0;
      const pushText = str => {
        for (const part of str.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { items.push({ k: 't', text: part }); continue; }
          if (!/[A-Za-z0-9]/.test(part)) {
            // A stand-alone "…" or dash belongs to the word before it.
            const prev = [...items].reverse().find(i => i.k === 'w');
            if (prev && /…|\.\.\./.test(part)) prev.pause = Math.max(prev.pause, PACE.ellipsis);
            items.push({ k: 't', text: part });
            continue;
          }
          const letters = (part.match(/[A-Za-z0-9]/g) || []).length;
          const end = part.replace(/["'’”)\]]+$/, '');
          let pause = 0, sync = false;
          if (/(…|\.\.\.)$/.test(end)) pause = PACE.ellipsis;
          else if (/\?$/.test(end)) { pause = PACE.question; sync = true; }
          else if (/[.!]$/.test(end)) { pause = PACE.sentence; sync = true; }
          else if (/[,;:—–]$/.test(end)) pause = PACE.comma;
          items.push({ k: 'w', text: part, letters, pause, sync });
        }
      };
      CUE.lastIndex = 0;
      for (const m of line.matchAll(CUE)) {
        pushText(line.slice(last, m.index));
        const kind = m[1].toLowerCase();
        const secs = Math.min(600, Number(m[2] || CUE_DEFAULT[kind]));
        items.push({ k: 'cue', kind, secs, text: kind === 'breath' ? 'Breath' : `${kind === 'silence' ? 'Silence' : 'Pause'} ${secs} s` });
        last = m.index + m[0].length;
      }
      pushText(line.slice(last));
      // A paragraph that ends without punctuation still gets a sentence-length pause.
      const lastWord = [...items].reverse().find(i => i.k === 'w');
      if (lastWord && !lastWord.pause) { lastWord.pause = PACE.sentence; lastWord.sync = true; }
      paras.push({ gap, items });
      gap = false;
    }
    return paras;
  }
  // Timeline of events with modelled durations (seconds at 100%).
  function model(paras) {
    const events = [];
    let total = 0;
    for (const p of paras) {
      if (p.gap && events.length) { const prev = events[events.length - 1]; prev.pause = (prev.pause || 0) + PACE.paragraph; total += PACE.paragraph; }
      for (const it of p.items) {
        if (it.k === 'w') {
          const ev = { k: 'w', item: it, dur: PACE.word + PACE.letter * it.letters, pause: it.pause, sync: it.sync };
          events.push(ev); total += ev.dur + ev.pause;
        } else if (it.k === 'cue') {
          const ev = { k: 'cue', item: it, hold: it.secs + (it.kind === 'breath' ? 0 : PACE.cueExtra) };
          // Sync with Adam before every scripted pause.
          const prev = events[events.length - 1];
          if (prev && prev.k === 'w') prev.sync = true;
          events.push(ev); total += ev.hold;
        }
      }
    }
    const pace = Number(ui.pace.value) / 100;
    for (const e of events) if (e.k === 'w') { e.dur /= pace; e.pause /= pace; }
    return { events, total: total / pace + 0 };
  }

  // ---------- microphone (voice activity only; nothing is recorded) ----------
  const mic = { on: false, voice: false, quiet: 0, talk: 0, db: -100, floor: -60 };
  async function startMic() {
    if (mic.on) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      mic.read = dt => {
        an.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        mic.db = 10 * Math.log10(s / buf.length + 1e-12);
        // Noise floor follows the quietest level: falls fast, rises slowly.
        mic.floor = mic.db < mic.floor ? mic.floor + (mic.db - mic.floor) * Math.min(1, dt * 4) : mic.floor + Math.min(0.6 * dt, mic.db - mic.floor);
        const over = mic.db - mic.floor;
        mic.voice = mic.voice ? over > 7 : over > 11;
        if (mic.muteUntil && performance.now() < mic.muteUntil) { mic.voice = false; mic.talk = 0; }
        if (mic.voice) { mic.talk += dt; mic.quiet = 0; } else { mic.quiet += dt; if (mic.quiet > 0.15) mic.talk = 0; }
      };
      mic.stream = stream; mic.ctx = ctx; mic.on = true;
      return true;
    } catch { return false; }
  }
  // ---------- gong: a soft struck-bowl tone, made on the iPad (no sound file) ----------
  // Rings with 1 s left on any pause longer than 3 s. While it rings, voice sync ignores the
  // microphone so the gong isn't mistaken for Adam speaking.
  const GONG_MIN = 3, GONG_LEAD = 1, GONG_RING = 2.5;
  let actx = null;
  function audio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state !== 'running') actx.resume();
    } catch { actx = null; }
    return actx;
  }
  function gong() {
    const ctx = audio();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.02, vol = Number(ui.gongVol.value) / 100;
    const out = ctx.createGain();
    out.gain.value = 0.32 * vol * vol + 0.02 * vol;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 2400; tone.Q.value = 0.4;
    tone.connect(out); out.connect(ctx.destination);
    // Partials of a small bowl gong: low, warm, slightly beating; the higher ones fade first.
    const f0 = 196;
    for (const [ratio, amp, decay, detune] of [[1, 1, 4.2, 0.6], [1, 0.5, 4.2, -0.6], [2.71, 0.32, 2.6, 0.8], [5.15, 0.12, 1.4, 0], [8.4, 0.05, 0.8, 0]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f0 * ratio + detune;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(amp, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + decay);
      o.connect(g); g.connect(tone);
      o.start(t0); o.stop(t0 + decay + 0.05);
    }
    mic.muteUntil = performance.now() + GONG_RING * 1000;
  }

  function stopMic() {
    if (!mic.on) return;
    mic.stream.getTracks().forEach(t => t.stop());
    mic.ctx.close();
    mic.on = false; mic.voice = false;
  }

  // ---------- stage ----------
  const stage = $('stage'), flip = $('flip'), text = $('text'), viewport = $('viewport');
  let tl = null, words = [], lines = [], run = null, frame = 0, wakeLock = null;

  function render() {
    const paras = parse(ui.script.value);
    tl = model(paras);
    text.replaceChildren();
    text.style.fontSize = `${ui.size.value}px`;
    let ei = 0;
    for (const p of paras) {
      const el = document.createElement('p');
      if (p.gap) el.style.marginTop = '1.1em';
      for (const it of p.items) {
        if (it.k === 't') {
          // Loose punctuation such as a stand-alone "…" dims along with the word before it.
          if (/\S/.test(it.text) && ei > 0) { const p = document.createElement('span'); p.textContent = it.text; (tl.events[ei - 1].tail ||= []).push(p); el.append(p); }
          else el.append(it.text);
          continue;
        }
        const span = document.createElement('span');
        span.className = it.k === 'w' ? 'w' : 'pz';
        span.textContent = it.text;
        el.append(span);
        tl.events[ei++].el = span;
      }
      text.append(el);
    }
    // Pad top and bottom so the first and last lines can reach the reading line.
    text.style.paddingTop = `${stage.clientHeight}px`;
    text.style.paddingBottom = `${stage.clientHeight}px`;
    layout();
  }
  function layout() {
    // Group events into visual lines by their vertical position.
    lines = [];
    for (const e of tl.events) {
      const top = e.el.offsetTop, h = e.el.offsetHeight;
      let L = lines[lines.length - 1];
      if (!L || Math.abs(top - L.top) > h * 0.5) { L = { top, h, events: [] }; lines.push(L); }
      L.events.push(e);
      e.line = L;
    }
    for (const L of lines) L.events.forEach((e, i) => { e.posInLine = i; });
    $('guide').style.top = `${ui.line.value}%`;
  }
  // Scroll target: the current line's centre sits on the reading line and drifts toward the next line as it is read.
  function targetY(i, frac) {
    const e = tl.events[Math.min(i, tl.events.length - 1)];
    const L = e.line, n = L.events.length;
    const f = Math.min(1, (e.posInLine + frac) / n);
    const next = lines[lines.indexOf(L) + 1];
    const centre = L.top + L.h / 2, nextCentre = next ? next.top + next.h / 2 : centre + L.h;
    return centre + (nextCentre - centre) * f;
  }
  function setY(y) {
    const guide = stage.clientHeight * Number(ui.line.value) / 100;
    text.style.transform = `translate3d(0, ${guide - y}px, 0)`;
  }
  function paint(i) {
    tl.events.forEach((e, j) => {
      e.el.classList.toggle('read', j < i);
      if (e.tail) for (const p of e.tail) p.classList.toggle('read', j < i);
      e.el.classList.toggle('now', j === i);
    });
  }

  function placeCue() {
    const box = $('cue'), H = stage.clientHeight, guide = H * Number(ui.line.value) / 100;
    const h = box.offsetHeight || 300, line = Number(ui.size.value) * 1.4;
    box.style.top = (guide - h - 24 >= 12) ? `${guide - h - 24}px` : `${Math.min(H - h - 100, guide + line * 2)}px`;
  }
  // Glass mode mirrors the text; practice mode reads normally on the iPad itself.
  function applyMirror() {
    const m = ui.mirror.checked, b = $('cMirror');
    flip.classList.toggle('mirrored', m);
    b.querySelector('b').textContent = m ? 'Practice' : 'Glass';
    b.title = m ? 'Show the words reading normally, for practice' : 'Mirror the words for the teleprompter glass';
    b.setAttribute('aria-pressed', String(!m));
    stage.classList.toggle('practice', !m);
  }
  function toggleMirror() { ui.mirror.checked = !ui.mirror.checked; persist(); labels(); applyMirror(); controls(true); }
  function open() {
    if (!ui.script.value.trim()) { ui.script.focus(); return; }
    persist();
    $('setup').hidden = true;
    stage.hidden = false;
    applyMirror();
    render();
    run = { i: 0, phase: 'idle', t: 0, y: targetY(0, 0), vy: 0, paused: false };
    setY(run.y); paint(-1);
    state('Ready');
    controls();
  }
  function close() {
    cancelAnimationFrame(frame);
    stopMic(); releaseWake();
    run = null;
    stage.hidden = true; stage.classList.remove('running');
    $('cue').hidden = true; $('count').hidden = true;
    $('setup').hidden = false;
  }
  function state(s) { $('state').textContent = s; }

  async function start() {
    if (ui.gong.checked) audio(); // unlock sound on this tap (iPad needs a tap first)
    if (ui.sync.checked) {
      state('Asking for the microphone…');
      const ok = await startMic();
      state(ok ? 'In step with Adam' : 'Microphone off · running at Adam’s pace');
    } else state('Running at Adam’s pace');
    requestWake();
    stage.classList.add('running');
    run.phase = 'count';
    run.t = Number(ui.countdown.value);
    $('count').hidden = false;
    loop.last = null;
    frame = requestAnimationFrame(loop);
    controls();
  }
  const running = () => run && !run.paused && run.phase !== 'idle' && run.phase !== 'done';
  // Start: from the top (with countdown), or carry on from where it stopped.
  function play() {
    if (!run) return;
    if (run.phase === 'done') { backToTop(); return start(); }
    if (run.phase === 'idle') return start().then(controls);
    if (!run.paused) return;
    if (ui.gong.checked) audio();
    run.paused = false;
    stage.classList.add('running');
    state(mic.on ? 'In step with Adam' : 'Running at Adam’s pace');
    requestWake();
    loop.last = null;
    frame = requestAnimationFrame(loop);
    controls();
  }
  // Stop: holds exactly where it is. A stop during the countdown goes back to the top.
  function stop() {
    if (!run || run.phase === 'idle' || run.phase === 'done' || run.paused) return;
    if (run.phase === 'count') return backToTop();
    run.paused = true;
    cancelAnimationFrame(frame);
    stage.classList.remove('running');
    state('Stopped · Start carries on from here');
    controls();
  }
  function backToTop() { cueAt(0); }
  // Park the prompter on a line, stopped, ready for a pickup. Start then counts down and goes from here.
  function cueAt(i) {
    if (!run) return;
    cancelAnimationFrame(frame);
    $('cue').hidden = true; $('count').hidden = true;
    i = Math.max(0, Math.min(i, tl.events.length - 1));
    run = { i, from: i, phase: 'idle', t: 0, y: targetY(i, 0), vy: 0, paused: false };
    stage.classList.add('cueing');
    setY(run.y);
    setTimeout(() => stage.classList.remove('cueing'), 400);
    if (i) paint(i); else paint(-1);
    stage.classList.remove('running');
    releaseWake();
    state(i ? 'Ready · picks up from the highlighted line' : 'Ready · at the top');
    controls();
  }
  // Sentence starts: the places a pickup can begin.
  function sentenceStarts() {
    const ev = tl.events, out = [0];
    for (let i = 1; i < ev.length; i++) {
      const prev = ev[i - 1], e = ev[i];
      if (e.k === 'cue') continue;
      if (prev.k === 'cue' || (prev.k === 'w' && prev.item.sync) || e.el.parentNode !== prev.el.parentNode) out.push(i);
    }
    return out;
  }
  // Back / Forward a sentence. While running it keeps running from there; when stopped it parks there.
  function jump(dir) {
    if (!run) return;
    const S = sentenceStarts();
    const cur = run.phase === 'idle' ? (run.from || 0) : run.phase === 'done' ? tl.events.length : run.i;
    let target;
    if (dir < 0) {
      const before = S.filter(s => s < cur);
      // Partway through a sentence, Back goes to its start; at a start, it goes to the one before.
      target = before.length ? before[before.length - 1] : 0;
    } else {
      target = S.find(s => s > cur);
      if (target == null) return;
    }
    if (running() && run.phase !== 'count') {
      $('cue').hidden = true;
      enter(target);
      controls(true);
    } else cueAt(target);
  }
  // Control bar: always shown when stopped; fades out while running so it stays out of the talent's view.
  let hideTimer;
  function controls(reveal) {
    if (!run) return;
    const playing = running();
    const label = run.phase === 'idle' ? (run.from ? 'Start from here' : 'Start') : run.phase === 'done' ? 'Start again' : run.paused ? 'Start' : 'Running';
    $('cPlay').querySelector('b').textContent = label;
    $('cPlay').disabled = playing;
    $('cStop').disabled = !playing;
    $('cTop').disabled = run.phase === 'idle' && !run.from;
    $('cBack').disabled = run.phase === 'idle' && !run.from;
    $('cFwd').disabled = run.phase === 'done';
    const bar = $('controls');
    clearTimeout(hideTimer);
    if (playing) {
      bar.classList.toggle('hide', !reveal);
      if (reveal) hideTimer = setTimeout(() => bar.classList.add('hide'), 3000);
    } else bar.classList.remove('hide');
  }

  function enter(i) {
    run.i = i;
    if (i >= tl.events.length) { run.phase = 'done'; paint(tl.events.length); $('cue').hidden = true; state('End of script'); stopMic(); releaseWake(); stage.classList.remove('running'); controls(); return; }
    const e = tl.events[i];
    paint(i);
    if (e.k === 'cue') {
      run.phase = 'cue'; run.t = 0; run.gonged = false;
      $('cueNum').textContent = Math.ceil(e.item.secs);
      $('cueBar').style.width = '100%';
      $('cue').hidden = false;
      placeCue();
      $('cueLabel').textContent = e.item.kind === 'breath' ? 'Breathe' : 'Hold';
    } else { run.phase = 'word'; run.t = 0; }
  }

  function loop(now) {
    if (!run || run.paused) return;
    const dt = loop.last == null ? 0 : Math.min(0.1, (now - loop.last) / 1000);
    loop.last = now;
    if (mic.on) mic.read(dt);

    if (run.phase === 'count') {
      run.t -= dt;
      $('count').textContent = Math.max(1, Math.ceil(run.t));
      if (run.t <= 0) { $('count').hidden = true; enter(run.from || 0); }
    } else if (run.phase === 'word') {
      const e = tl.events[run.i];
      run.t += dt;
      if (run.t >= e.dur) {
        run.phase = 'pause'; run.t = 0; run.need = e.pause;
        if (mic.on && e.sync) {
          if (mic.voice) run.phase = 'wait';                       // Adam is still talking: we are ahead, wait for him
          else run.need = Math.max(0.15, e.pause - mic.quiet);     // he already finished: we are behind, shorten the pause
        }
      }
    } else if (run.phase === 'wait') {
      run.t += dt;
      if ((!mic.voice && mic.quiet > 0.25) || run.t > 6) { run.phase = 'pause'; run.t = 0; run.need = Math.max(0.15, tl.events[run.i].pause - mic.quiet); }
    } else if (run.phase === 'pause') {
      run.t += dt;
      const e = tl.events[run.i];
      const resumed = mic.on && e.sync && run.t > 0.25 && mic.talk > 0.12;  // he started the next sentence early
      if (run.t >= run.need || resumed) enter(run.i + 1);
    } else if (run.phase === 'cue') {
      const e = tl.events[run.i];
      run.t += dt;
      const left = Math.max(0, e.hold - run.t);
      if (!run.gonged && ui.gong.checked && e.item.kind !== 'breath' && e.item.secs > GONG_MIN && left <= GONG_LEAD) { run.gonged = true; gong(); }
      $('cueNum').textContent = Math.ceil(left * e.item.secs / e.hold);
      $('cueBar').style.width = `${(left / e.hold) * 100}%`;
      const resumed = mic.on && run.t > e.hold * 0.6 && mic.talk > 0.5;
      if (left <= 0 || resumed) { $('cue').hidden = true; enter(run.i + 1); }
    }

    // Smooth scroll toward the target with a critically damped spring.
    if (run.phase !== 'count' && run.phase !== 'done' && run.i < tl.events.length) {
      const e = tl.events[run.i];
      const frac = run.phase === 'word' ? Math.min(1, run.t / e.dur) : 1;
      const ty = targetY(run.i, e.k === 'cue' ? 0 : frac);
      const w = 3.2;
      run.vy += (w * w * (ty - run.y) - 2 * w * run.vy) * dt;
      run.y += run.vy * dt;
      setY(run.y);
    }
    if (run.phase !== 'done') frame = requestAnimationFrame(loop);
  }

  // ---------- wake lock ----------
  async function requestWake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
  function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && run && run.phase !== 'idle' && run.phase !== 'done') requestWake(); });

  // ---------- input ----------
  // A tap anywhere brings the controls back while it runs; the buttons do the work.
  stage.addEventListener('click', ev => {
    if (drag.moved) { drag.moved = false; return; }
    if (!ev.target.closest('#controls')) controls(true);
  });
  // When stopped, drag the text up or down to find a pickup point; it settles on the nearest line.
  const drag = { on: false, moved: false };
  stage.addEventListener('pointerdown', ev => {
    if (!run || running() || ev.target.closest('#controls') || !ev.isPrimary) return;
    Object.assign(drag, { on: true, moved: false, y0: ev.clientY, start: run.y });
  });
  stage.addEventListener('pointermove', ev => {
    if (!drag.on) return;
    const dy = ev.clientY - drag.y0;
    if (Math.abs(dy) > 8) drag.moved = true;
    if (!drag.moved) return;
    const first = lines[0], last = lines[lines.length - 1];
    run.y = Math.max(first.top, Math.min(last.top + last.h, drag.start - dy));
    setY(run.y);
  });
  const endDrag = () => {
    if (!drag.on) return;
    drag.on = false;
    if (!drag.moved) return;
    // Settle on the sentence start closest to where the text was left.
    const S = sentenceStarts();
    let best = S[0];
    for (const i of S) { const L = tl.events[i].line; if (Math.abs(L.top + L.h / 2 - run.y) < Math.abs(tl.events[best].line.top + tl.events[best].line.h / 2 - run.y)) best = i; }
    cueAt(best);
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  $('cBack').addEventListener('click', () => jump(-1));
  $('cFwd').addEventListener('click', () => jump(1));
  $('cPlay').addEventListener('click', play);
  $('cStop').addEventListener('click', stop);
  $('cTop').addEventListener('click', backToTop);
  $('cScript').addEventListener('click', close);
  $('cMirror').addEventListener('click', toggleMirror);
  document.addEventListener('keydown', ev => {
    if (stage.hidden) return;
    if (ev.key === 'Escape') close();
    else if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); running() ? stop() : play(); }
    else if (ev.key === 'm' || ev.key === 'M') toggleMirror();
    else if (ev.key === 'Home' || ev.key === 'r' || ev.key === 'R') backToTop();
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' || ev.key === 'PageUp') { ev.preventDefault(); jump(-1); }
    else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' || ev.key === 'PageDown') { ev.preventDefault(); jump(1); }
  });
  window.addEventListener('resize', () => { if (!stage.hidden && tl) { text.style.paddingTop = text.style.paddingBottom = `${stage.clientHeight}px`; layout(); } });
  $('go').addEventListener('click', open);
  $('gongTest').addEventListener('click', gong);
  for (const b of document.querySelectorAll('[data-ins]')) b.addEventListener('click', () => {
    const t = ui.script, s = t.selectionStart, e = t.selectionEnd, ins = ` ${b.dataset.ins} `;
    t.value = t.value.slice(0, s) + ins + t.value.slice(e);
    t.focus(); t.selectionStart = t.selectionEnd = s + ins.length;
    persist(); labels();
  });
  let typing;
  ui.script.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { persist(); labels(); }, 300); });
  for (const k of ['mirror', 'sync', 'pace', 'size', 'line', 'countdown', 'gong', 'gongVol']) ui[k].addEventListener('input', () => { persist(); labels(); });
  labels();

  // ---------- Program scripts ----------
  const lib = window.PROMPTER_SCRIPTS || [];
  function markLoaded() {
    for (const b of document.querySelectorAll('#library [data-id]')) b.classList.toggle('on', lib.find(x => x.id === b.dataset.id)?.text === ui.script.value);
  }
  function load(id) {
    const sc = lib.find(x => x.id === id);
    if (!sc) return;
    const cur = ui.script.value.trim();
    if (cur && cur !== sc.text && !lib.some(x => x.text === ui.script.value) && !confirm('Replace the script that’s in the box with ' + sc.title + '?')) return;
    ui.script.value = sc.text;
    persist(); labels(); markLoaded();
    ui.script.scrollTop = 0;
    $('saved').textContent = `${sc.title} loaded · script updated ${sc.updated}. Edits are saved on this iPad.`;
  }
  if (lib.length) {
    const box = $('library');
    box.innerHTML = '';
    let group = null;
    for (const sc of lib) {
      if (sc.group !== group) {
        group = sc.group;
        const h = document.createElement('div');
        h.className = 'lib-head';
        h.textContent = group || 'Program scripts';
        box.append(h);
      }
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.id = sc.id;
      b.innerHTML = `${sc.title}<small>${sc.sub}${sc.updated ? ' · ' + sc.updated : ''}</small>`;
      b.addEventListener('click', () => load(sc.id));
      box.append(b);
    }
    markLoaded();
    ui.script.addEventListener('input', markLoaded);
    // A link such as /prompter?script=w2d1 opens with that script loaded.
    const q = new URLSearchParams(location.search), want = q.get('script');
    // ?practice=1 opens reading normally (not mirrored); ?glass=1 forces the mirror back on.
    if (q.has('practice')) { ui.mirror.checked = false; persist(); }
    if (q.has('glass')) { ui.mirror.checked = true; persist(); }
    if (want) load(want.toLowerCase());
  }

  // ---------- import a Word / PDF / text script ----------
  const drop = $('drop'), msg = $('dropMsg');
  async function importFile(file) {
    if (!file || !window.PrompterImport) return;
    drop.classList.add('busy'); msg.textContent = `Reading ${file.name}…`;
    try {
      const r = await window.PrompterImport.fromFile(file);
      const cur = ui.script.value.trim();
      if (cur && !lib.some(x => x.text === ui.script.value) && !confirm(`Replace the script that’s in the box with ${r.title}?`)) { msg.textContent = 'Kept the script that was already in the box.'; return; }
      ui.script.value = r.text;
      persist(); labels(); markLoaded();
      ui.script.scrollTop = 0;
      const p = r.pauses ? `${r.pauses} pause${r.pauses > 1 ? 's' : ''} added (${Math.round(r.pauseSecs)} s in all)` : 'No pauses were written in it; add any with the buttons below';
      const left = r.removed.length ? ` Left out: ${r.removed.slice(0, 6).join(' · ')}${r.removed.length > 6 ? ' …' : ''}.` : '';
      msg.innerHTML = '';
      msg.append(Object.assign(document.createElement('b'), { textContent: `${r.title} loaded. ` }), `${p}. Check it over before the take.${left}`);
      $('saved').textContent = `${r.title} imported. Edits are saved on this iPad.`;
    } catch (e) {
      msg.textContent = e && e.message ? e.message : 'Could not read that file.';
    } finally { drop.classList.remove('busy'); }
  }
  $('pick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', e => { importFile(e.target.files[0]); e.target.value = ''; });
  const setup = $('setup');
  let depth = 0;
  setup.addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); depth++; drop.classList.add('over'); } });
  setup.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  setup.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('over'); } });
  setup.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); depth = 0; drop.classList.remove('over');
    importFile(e.dataTransfer.files[0]);
  });

  // Exposed for testing the pace model against real recordings.
  window.PrompterModel = { parse, model, PACE };
})();
