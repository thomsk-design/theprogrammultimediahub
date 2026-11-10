(() => {
  const storageKey = 'program-teleprompter-v1';
  const audio = window.TalentAudio;
  let draft = '', speed = 40, size = 44, follow = false, recOn = false, driveUp = true;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    draft = typeof saved.text === 'string' ? saved.text : '';
    speed = Math.min(120, Math.max(10, Number(saved.speed) || 40));
    size = Math.min(80, Math.max(24, Number(saved.size) || 44));
    follow = saved.follow === true;
    recOn = saved.rec === true;
    driveUp = saved.driveUp !== false;
  } catch {}
  // [SILENCE: ~3 SECONDS], [Pause: 5s], plain [Pause] (2s) and [Breath] (1s)
  const cuePattern = /\[\s*(silence|pause|breath)\s*(?::\s*(?:\\?~\s*)?(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)?)?\s*\]/gi;
  const cueDefaults = { silence: 2, pause: 2, breath: 1 };
  const clock = date => date.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const today = () => new Date().toLocaleDateString('en-CA');
  // Remember the chosen takes folder between visits (Chrome / Edge only).
  const canPickFolder = typeof window.showDirectoryPicker === 'function';
  function kv(mode, fn) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('program-talent', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { const tx = req.result.transaction('kv', mode); const r = fn(tx.objectStore('kv')); tx.oncomplete = () => resolve(r && r.result); tx.onerror = () => reject(tx.error); };
    });
  }
  const loadFolder = () => kv('readonly', st => st.get('takes-folder')).catch(() => null);
  const saveFolder = handle => kv('readwrite', st => st.put(handle, 'takes-folder')).catch(() => {});
  const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function open(script) {
    if (document.querySelector('.prompter')) return;
    const emphasisKey = storageKey + '-emphasis-' + (script ? script.id : 'draft');
    const takesKey = storageKey + '-takes-' + (script ? script.id : 'draft');
    let ranges = [], scriptText = script ? script.body : draft;
    try {
      const saved = JSON.parse(localStorage.getItem(emphasisKey) || '{}');
      if (script && saved.source === script.body && typeof saved.text === 'string') scriptText = saved.text;
      if (saved.text === scriptText && Array.isArray(saved.ranges)) ranges = saved.ranges.filter(r => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] > r[0] && r[1] <= saved.text.length);
    } catch {}
    let takes = [];
    try {
      const saved = JSON.parse(localStorage.getItem(takesKey) || '{}');
      if (saved.date === today() && Array.isArray(saved.takes)) takes = saved.takes;
    } catch {}

    const dialog = document.createElement('dialog');
    dialog.className = 'prompter';
    dialog.setAttribute('aria-labelledby', 'prompter-title');
    dialog.innerHTML = `<header class="prompter-header"><div><div class="eyebrow">YOUR WORDS. YOUR PACE.</div><h2 id="prompter-title">${script ? 'Teleprompter · ' + escapeHtml(script.title) : 'Teleprompter'}</h2></div><div class="ph-actions"><button class="btn" data-p-focus hidden title="Hide controls (H)">Hide controls</button><button class="btn" data-p-close>Close ×</button></div></header>
      <section class="prompter-editor"><label for="prompter-input">Add your script</label><p class="small muted">Paste your words below. Keep line breaks and pause cues wherever you need a breath.</p><textarea id="prompter-input" placeholder="Paste or type your script here…"></textarea><div class="prompter-emphasis-tools"><button class="btn" data-p-highlight>Highlight selected words</button><button class="btn" data-p-clear>Clear emphasis</button><span class="small muted">Select words above, then highlight them for emphasis.</span></div><div class="prompter-emphasis-tools"><label>Silence (seconds at normal speed) <input data-p-gap type="number" min="0.5" max="300" step="0.5" value="3" style="width:85px" aria-label="Silence duration"></label><button class="btn" data-p-insert-gap>Insert silence at cursor</button><span class="small muted">Understands [SILENCE: ~3 SECONDS], [Pause: 5s], plain [Pause] (2s) and [Breath] (1s). At half speed, 3 seconds becomes 6.</span></div><p class="small muted" data-p-saved>Saved in this browser only.</p><button class="btn primary" data-p-read>Open reader →</button></section>
      <section class="prompter-reader" hidden>
        <div class="prompter-bar">
          <div class="pb-transport"><button class="btn primary" data-p-play>Start</button><button class="btn" data-p-restart>Restart</button><button class="btn" data-p-mark title="Drop a marker (M)">Mark</button></div>
          <div class="pb-stats">
            <div class="pb-stat"><small>Take</small><output data-p-take>—</output></div>
            <div class="pb-stat"><small>Elapsed</small><output data-p-elapsed>00:00</output></div>
            <div class="pb-stat"><small>Remaining</small><output data-p-remaining>00:00</output></div>
            <div class="pb-stat"><small>Pace</small><output data-p-wpm>—</output></div>
            <div class="pb-stat pb-wide"><small>Next cue</small><output data-p-countdown>—</output></div>
          </div>
          <div class="pb-mic prompter-audio">
            <button class="btn" data-p-connect>Connect mic</button>
            <div class="pa-meter-wrap"><div class="pa-meter" aria-hidden="true"><div class="pa-fill"></div><div class="pa-peak"></div><div class="pa-threshold"></div></div></div>
            <span class="pb-rec" data-p-rec hidden></span>
            <output class="pa-db" data-p-db>— dB</output>
            <span class="pa-light" data-p-voice data-state="off">Mic off</span>
          </div>
          <div class="pb-end"><label class="pb-toggle" title="Follow my voice (F)"><input type="checkbox" data-p-follow><span>Follow voice</span></label><button class="btn" data-p-settings aria-expanded="false">Adjust</button></div>
        </div>
        <div class="prompter-drawer" hidden>
          <section><h3>Microphone</h3>
            <div class="dr-row"><select data-p-device aria-label="Audio input"><option value="">Default input</option></select><button class="btn" data-p-disconnect>Disconnect</button></div>
            <div class="dr-row"><button class="btn" data-p-calibrate disabled title="Stay quiet for 3 seconds so the desk can hear the room">Room tone</button><label class="dr-check" title="Set the trigger automatically, just above the room's background noise"><input type="checkbox" data-p-auto> Auto trigger</label></div>
            <label class="dr-range">Trigger <input type="range" min="-85" max="-15" step="1" data-p-threshold aria-label="Speaking trigger level"><output data-p-threshold-label></output></label>
            <p class="dr-note" data-p-mode></p>
          </section>
          <section><h3>Reading</h3>
            <label class="dr-range">Speed <input type="range" min="10" max="120" step="5" data-p-speed aria-label="Scroll speed"><output data-p-speed-label></output></label>
            <label class="dr-range">Text size <input type="range" min="24" max="80" step="2" data-p-size aria-label="Text size"><output data-p-size-label></output></label>
            <p class="dr-note">Speed is used when not following the voice. Silences scale with it.</p>
          </section>
          <section><h3>Backup recording</h3>
            <label class="dr-check"><input type="checkbox" data-p-rec-on> Record each take to a folder</label>
            <div class="dr-row"><button class="btn" data-p-folder>Choose folder…</button><span class="dr-folder" data-p-folder-name></span></div>
            <label class="dr-check" data-p-drive-row hidden><input type="checkbox" data-p-drive> Also upload each take to Google Drive</label>
            <p class="dr-note" data-p-rec-note></p>
          </section>
          <section><h3>Script</h3>
            <div class="dr-row"><button class="btn" data-p-edit>Edit script</button><button class="btn" data-p-reader-highlight>Highlight selection</button><button class="btn" data-p-reader-clear>Clear emphasis</button></div>
            <div class="dr-row"><button class="btn" data-p-takes>Download take log ↓</button></div>
            <p class="dr-note">Space start / pause · ← → speed · ↑ ↓ move · M mark · F follow voice · H hide controls · Home restart · Esc close</p>
          </section>
        </div>
        <div class="prompter-stage">
          <div class="prompter-progress" aria-hidden="true"><span></span></div>
          <div class="prompter-guide" aria-hidden="true"></div>
          <div class="prompter-vu" aria-hidden="true"><span></span><i></i></div>
          <div class="prompter-viewport" tabindex="0" aria-label="Script reader. Use Space to pause or resume."><div class="prompter-text"></div></div>
          <div class="prompter-shade" aria-hidden="true"></div>
          <div class="prompter-cue" data-p-cue hidden><div class="pc-ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="pc-track" cx="60" cy="60" r="52"/><circle class="pc-arc" cx="60" cy="60" r="52" pathLength="100"/></svg><strong data-p-cue-num></strong></div><div class="pc-label" data-p-cue-label></div></div>
          <button class="prompter-unfocus" data-p-unfocus title="Show controls (H)">Show controls</button>
        </div>
        <div class="prompter-status" role="status" aria-live="polite">Ready when you are.</div>
      </section>`;
    document.body.append(dialog);
    const q = selector => dialog.querySelector(selector);
    const input = q('textarea'), viewport = q('.prompter-viewport');
    const editor = q('.prompter-editor'), reader = q('.prompter-reader');
    const cueBox = q('[data-p-cue]');
    let playing = false, frame = 0, last = null, position = 0;
    input.value = scriptText;
    let previousText = input.value;
    let elapsed = 0, cues = [], activeCue = null, fresh = true, currentTake = null;
    let pxPerWord = 0, goUntil = 0, lastStatus = '', holding = false;
    const completedCues = new Set();
    const formatTime = seconds => { const whole = Math.max(0, Math.ceil(seconds)); return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`; };
    const listening = () => follow && audio && audio.level.connected;
    const cueSeconds = cue => cue.seconds * 40 / speed;
    const cueName = cue => cue.kind === 'breath' ? 'breath' : 'silence';
    function status(text) { if (text !== lastStatus) { q('.prompter-status').textContent = text; lastStatus = text; } }

    function cuePosition(cue) {
      return Math.max(0, cue.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - window.innerHeight * 0.15);
    }
    function measure() {
      const text = q('.prompter-text');
      if (reader.hidden || !text.offsetHeight) { pxPerWord = 0; return; }
      const style = getComputedStyle(text);
      const height = text.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const words = (input.value.replace(cuePattern, ' ').match(/\S+/g) || []).length;
      pxPerWord = words && height > 0 ? height / words : 0;
    }
    function nextCue() { return cues.find(c => c !== activeCue && !completedCues.has(c.index)); }

    // ---- Word tracking: listen to the words and keep the script on the line being read ----
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let vel = 0, pVel = 0, sIdx = 0, sVel = 0, rows = [], wordRow = [], rowsDirty = true, quietSince = 0, lastTiming = 0;
    let words = [], cursor = 0, rec = null, recWanted = false, recWhere = '', wordsOn = false, wordsFailed = false, paceLog = [], prerollUntil = 0;
    function normWord(word) { return word.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, ''); }
    const same = (a, b) => a === b || (a.length > 3 && b.length > 3 && (a.startsWith(b) || b.startsWith(a)));
    function offsetOf(el) { return Math.max(0, el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - window.innerHeight * 0.15); }
    function paintWords(from, to) {
      for (let i = Math.max(0, from); i < Math.min(words.length, to); i++) words[i].el.classList.add('said');
      const now = q('.prompter-text .w.now');
      if (now) now.classList.remove('now');
      if (words[cursor] && wordsOn) words[cursor].el.classList.add('now');
    }
    // Smooth scrolling: whole pixels via scrollTop, the fraction via transform.
    function setScroll(p) {
      position = Math.max(0, p);
      const whole = Math.floor(position);
      viewport.scrollTop = whole;
      q('.prompter-text').style.transform = `translateY(${(whole - viewport.scrollTop) - (position - whole)}px)`;
    }
    function settleScroll() { q('.prompter-text').style.transform = ''; position = viewport.scrollTop; }
    // Rows of text (and cue boxes) so the scroll can glide through a line as its words are read.
    function layout() {
      const items = words.map((w, i) => ({ top: offsetOf(w.el), i })).concat(cues.map(c => ({ top: offsetOf(c.element), cue: c })));
      items.sort((a, b) => a.top - b.top);
      rows = []; wordRow = new Array(words.length);
      for (const it of items) {
        let row = rows[rows.length - 1];
        if (!row || it.cue || row.cue || Math.abs(it.top - row.top) > 4) { row = { top: it.top, first: null, count: 0, cue: it.cue || null }; rows.push(row); }
        if (it.i !== undefined) { if (row.first === null) row.first = it.i; row.count++; wordRow[it.i] = rows.length - 1; }
      }
      rowsDirty = false;
    }
    function yFor(f) {
      if (!words.length) return position;
      if (rowsDirty) layout();
      const i = Math.min(words.length - 1, Math.max(0, Math.floor(f)));
      const frac = Math.min(1, Math.max(0, f - i));
      const r = wordRow[i], row = rows[r], next = rows[r + 1];
      const span = next ? next.top - row.top : 0;
      return row.top + span * (i - row.first + frac) / row.count;
    }
    // A pause starts when the talent goes quiet within the last couple of words before it,
    // even if speech recognition missed those words.
    function cueIfNear() {
      const c = cues.find(c => !completedCues.has(c.index) && c.wordIndex > cursor && c.wordIndex - cursor <= 2);
      if (!c) return;
      const from = cursor;
      cursor = c.wordIndex;
      paintWords(from, cursor);
      activeCue = c;
      c.remaining = c.seconds;
    }
    function clearWords() { for (const w of words) w.el.classList.remove('said', 'now'); }
    function advanceTo(n, strong) {
      if (activeCue) {
        if (!(strong && n > activeCue.wordIndex)) return;           // still in the pause
        completedCues.add(activeCue.index); activeCue = null;          // they read on, so skip the rest of the pause
      }
      if (n <= cursor) return;
      for (const c of cues) {
        if (completedCues.has(c.index) || c.wordIndex <= cursor || c.wordIndex > n) continue;
        if (c.wordIndex < n && strong) { completedCues.add(c.index); continue; }
        n = c.wordIndex; activeCue = c; c.remaining = c.seconds;
        break;
      }
      paceLog.push({ t: performance.now(), n: n - cursor });
      const from = cursor;
      cursor = n;
      paintWords(from, n);
    }
    function align(heard) {
      if (!heard.length || !words.length) return;
      const tail = heard.slice(-6);
      let best = null;
      for (let j = Math.max(0, cursor - 2), hi = Math.min(words.length - 1, cursor + 30); j <= hi; j++) {
        let k = tail.length - 1, i = j, score = 0, misses = 0;
        while (k >= 0 && i >= 0 && misses <= 2) {
          if (same(tail[k], words[i].norm)) { score++; k--; i--; }
          else if (k > 0 && same(tail[k - 1], words[i].norm)) { k--; misses++; }
          else { i--; misses++; }
        }
        const reach = j + 1 - cursor;
        if (score < (tail.length >= 3 ? 2 : 1) || (score < 2 && reach > 3)) continue;
        const value = score * 10 - Math.abs(reach) * 0.4;
        if (!best || value > best.value) best = { j, value, score };
      }
      if (best) advanceTo(best.j + 1, best.score >= 3);
    }
    function syncCursor() {
      if (!words.length || (words[cursor] && Math.abs(offsetOf(words[cursor].el) - viewport.scrollTop) < 60)) return;
      const index = words.findIndex(w => offsetOf(w.el) >= viewport.scrollTop - 4);
      cursor = index < 0 ? words.length : index;
      clearWords(); paintWords(0, cursor);
      sIdx = cursor; sVel = 0;
      for (const c of cues) if (c.wordIndex < cursor || (c.wordIndex === cursor && cursor > 0 && offsetOf(c.element) < viewport.scrollTop - 4)) completedCues.add(c.index);
    }
    function modeLabel() {
      q('[data-p-mode]').textContent = !follow ? '' : !SR ? 'Voice level only (this browser can’t follow words)' : wordsFailed ? 'Voice level (word following unavailable)' : wordsOn ? `Following words · heard on ${recWhere}` : 'Follows your words when you press Start';
    }
    function launch() {
      const track = audio && audio.track && audio.track();
      try { if (track) rec.start(track); else rec.start(); }
      catch { try { rec.start(); } catch {} }
    }
    async function startRecognition() {
      if (!SR) { modeLabel(); return false; }
      if (rec) return true;
      recWanted = true; wordsOn = true; recWhere = 'an online speech service';
      const r = rec = new SR();
      r.continuous = true; r.interimResults = true; r.lang = 'en-US'; r.maxAlternatives = 1;
      try {
        if ('processLocally' in r && SR.available && await SR.available({ langs: ['en-US'], processLocally: true }) === 'available') { r.processLocally = true; recWhere = 'this computer'; }
      } catch {}
      r.onresult = event => {
        if (rec !== r) return;
        let text = '';
        for (let i = 0; i < event.results.length; i++) text += ' ' + event.results[i][0].transcript;
        align((text.match(/\S+/g) || []).map(normWord).filter(Boolean));
        if (!activeCue && event.results[event.results.length - 1].isFinal) cueIfNear();
      };
      r.onerror = event => {
        if (rec !== r || ['no-speech', 'aborted'].includes(event.error)) return;
        wordsFailed = true;
        stopRecognition();
        modeLabel();
        status(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'Word following was blocked by the browser. Following voice level instead.' : event.error === 'network' ? 'Can’t reach the speech service. Following voice level instead.' : 'Word following stopped. Following voice level instead.');
      };
      r.onend = () => { if (rec === r && recWanted) setTimeout(() => { if (rec === r && recWanted) launch(); }, 120); };
      if (rec === r && recWanted) launch();
      modeLabel();
      return true;
    }
    function stopRecognition() {
      recWanted = false; wordsOn = false;
      const r = rec; rec = null;
      if (r) { try { r.abort(); } catch {} }
      const now = q('.prompter-text .w.now');
      if (now) now.classList.remove('now');
      modeLabel();
    }

    function showCue(mode, number, label, fraction = 1) {
      cueBox.hidden = false;
      cueBox.dataset.mode = mode;
      q('[data-p-cue-num]').textContent = number;
      q('[data-p-cue-label]').textContent = label;
      q('.pc-arc').style.strokeDashoffset = String(100 - Math.max(0, Math.min(1, fraction)) * 100);
    }
    function updateCue() {
      if (activeCue) {
        const left = activeCue.remaining * 40 / speed;
        const waiting = listening() && audio.level.voice;
        showCue(waiting ? 'waiting' : 'silence', Math.ceil(left), waiting ? 'Waiting for quiet' : activeCue.kind === 'breath' ? 'Breathe' : 'Hold the silence', activeCue.remaining / activeCue.seconds);
      } else if (performance.now() < goUntil) {
        showCue('go', 'Go', 'Next line', 1);
      } else {
        const next = playing && nextCue();
        const until = next ? (cuePosition(next) - position) / speed : Infinity;
        if (next && until <= 3 && until > 0 && !holding) showCue('upcoming', Math.ceil(until), `${next.kind === 'breath' ? 'Breath' : 'Silence'} coming`, 1 - until / 3);
        else cueBox.hidden = true;
      }
    }
    function timing() {
      q('[data-p-elapsed]').textContent = formatTime(elapsed);
      const distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      const scrollSeconds = distance <= 1 ? 0 : distance / speed;
      const silenceSeconds = cues.reduce((total, cue) => total + (completedCues.has(cue.index) ? 0 : cue === activeCue ? cue.remaining : cue.seconds), 0) * 40 / speed;
      q('[data-p-remaining]').textContent = formatTime(scrollSeconds + silenceSeconds);
      if (!pxPerWord) measure();
      const recent = paceLog.filter(p => performance.now() - p.t < 20000);
      if (wordsOn && recent.length > 2) {
        const span = Math.max(5000, performance.now() - recent[0].t);
        q('[data-p-wpm]').textContent = `${Math.round(recent.reduce((t, p) => t + p.n, 0) * 60000 / span)} wpm`;
      } else q('[data-p-wpm]').textContent = pxPerWord ? `${Math.round(speed * 60 / pxPerWord)} wpm` : '—';
      const next = nextCue();
      const until = next ? (cuePosition(next) - position) / speed : null;
      q('[data-p-countdown]').textContent = activeCue ? `${activeCue.kind === 'breath' ? 'Breath' : 'Silence'} now · ${cueSeconds(activeCue).toFixed(1)}s`
        : next && until !== null && until >= 0 ? `${next.kind === 'breath' ? 'Breath' : 'Silence'} ${cueSeconds(next).toFixed(1)}s${wordsOn ? '' : ' in ' + formatTime(until)}` : cues.length ? 'None left' : 'None';
      for (const cue of cues) cue.element.dataset.duration = `${Number(cueSeconds(cue).toFixed(1))}s ${cueName(cue)}`;
      const max = viewport.scrollHeight - viewport.clientHeight;
      q('.prompter-progress span').style.transform = `scaleX(${max > 0 ? Math.min(1, viewport.scrollTop / max) : 0})`;
      if (recorder) q('[data-p-rec]').textContent = `REC ${formatTime(recorder.seconds)}`;
      q('[data-p-take]').textContent = currentTake ? `${currentTake.take} · ${currentTake.started.slice(0, 5)}` : `${takes.length + 1} · ready`;
      updateCue();
    }
    function syncCues() {
      activeCue = null;
      completedCues.clear();
      for (const cue of cues) if (cuePosition(cue) < viewport.scrollTop - 2) completedCues.add(cue.index);
      timing();
    }
    function renderText() {
      const target = q('.prompter-text');
      target.replaceChildren();
      const matches = [...input.value.matchAll(cuePattern)].map(m => ({ index: m.index, length: m[0].length, kind: m[1].toLowerCase(), seconds: m[2] === undefined ? cueDefaults[m[1].toLowerCase()] : Number(m[2]) })).filter(m => m.seconds > 0 && m.seconds <= 300);
      const boundaries = new Set([0, input.value.length]);
      for (const [start, end] of ranges) { boundaries.add(start); boundaries.add(end); }
      for (const match of matches) { boundaries.add(match.index); boundaries.add(match.index + match.length); }
      const points = [...boundaries].sort((a, b) => a - b);
      cues = [];
      words = [];
      cursor = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const start = points[i], end = points[i + 1];
        const match = matches.find(m => start >= m.index && end <= m.index + m.length);
        const emphasized = ranges.some(r => start >= r[0] && end <= r[1]);
        const element = document.createElement(match ? 'span' : emphasized ? 'mark' : 'span');
        const slice = input.value.slice(start, end);
        if (match) {
          // Preserve the original cue text so emphasis selections retain their offsets.
          element.textContent = slice;
          element.className = 'prompter-silence' + (match.kind === 'breath' ? ' is-breath' : '');
          // wordIndex: the first word after this cue. The cue runs once every word before it has been heard.
          if (!cues.some(c => c.index === match.index)) cues.push({ index: match.index, kind: match.kind, seconds: match.seconds, remaining: match.seconds, element, wordIndex: words.length });
        } else {
          // Wrap each word so it can be tracked and highlighted. Text content is unchanged.
          for (const part of slice.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { element.append(part); continue; }
            const span = document.createElement('span');
            span.className = 'w';
            span.textContent = part;
            element.append(span);
            const norm = normWord(part);
            if (norm) words.push({ norm, el: span });
          }
        }
        target.append(element);
      }
      measure();
      rowsDirty = true;
      syncCues();
    }

    function highlight(start, end) {
      if (start === end) return false;
      ranges.push([start, end]);
      ranges.sort((a, b) => a[0] - b[0]);
      ranges = ranges.reduce((merged, range) => {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
        return merged;
      }, []);
      renderText();
      persist();
      return true;
    }
    function clearEmphasis() { ranges = []; renderText(); persist(); }
    function persist() {
      draft = input.value;
      try {
        localStorage.setItem(storageKey, JSON.stringify({ text: draft, speed, size, follow, rec: recOn, driveUp }));
        localStorage.setItem(emphasisKey, JSON.stringify({ text: input.value, ranges, source: script ? script.body : null }));
        q('[data-p-saved]').textContent = 'Saved in this browser only.';
      } catch { q('[data-p-saved]').textContent = 'Browser storage unavailable. Keep a copy of your script before closing.'; }
    }
    function saveTakes() { try { localStorage.setItem(takesKey, JSON.stringify({ date: today(), takes: takes.slice(-200) })); } catch {} }
    function closeTake() { if (currentTake) { currentTake.length = formatTime(elapsed); saveTakes(); } }

    function pause(message = 'Paused. Take your time.') {
      playing = false;
      vel = 0; sVel = 0; pVel = 0;
      settleScroll();
      prerollUntil = 0;
      if (rec) stopRecognition();
      holding = false;
      cancelAnimationFrame(frame);
      last = null;
      q('[data-p-play]').textContent = 'Resume';
      q('[data-p-play]').setAttribute('aria-pressed', 'false');
      closeTake();
      status(message);
      timing();
    }
    function tick(time) {
      if (!playing) return;
      if (performance.now() < prerollUntil) {
        const left = (prerollUntil - performance.now()) / 1000;
        showCue('preroll', Math.ceil(left), 'Is the H2 recording?', left / 3);
        status('Check the red record light on the H2. Starting in a moment…');
        last = null;
        frame = requestAnimationFrame(tick);
        return;
      }
      if (last !== null) {
        const dt = Math.min((time - last) / 1000, 0.1);
        const hearing = listening();
        elapsed += dt;
        if (wordsOn) {
          const now = performance.now(), lv = audio && audio.level.connected ? audio.level : null;
          if (lv) { if (lv.voice) quietSince = 0; else if (!quietSince) quietSince = now; }
          if (!activeCue && lv && quietSince && now - quietSince > 450) cueIfNear();
          if (activeCue) {
            if (!(audio && audio.level.connected) || !audio.level.voice) activeCue.remaining = Math.max(0, activeCue.remaining - dt * speed / 40);
            if (activeCue.remaining === 0) { completedCues.add(activeCue.index); activeCue = null; goUntil = performance.now() + 900; paintWords(cursor, cursor); }
          }
          // Glide toward the reading position with a critically damped spring (no snapping).
          const pending = cues.find(c => !completedCues.has(c.index) && c !== activeCue && c.wordIndex >= cursor);
          let t = activeCue ? activeCue.wordIndex : cursor + (lv ? (lv.voice ? 0.7 : 0) : 0.4);
          if (pending && pending.wordIndex > 0) t = Math.min(t, pending.wordIndex - 0.001);
          t = Math.min(t, words.length);
          const w = 2.6;
          sVel += (w * w * (t - sIdx) - 2 * w * sVel) * dt;
          sIdx += sVel * dt;
          const targetY = activeCue ? offsetOf(activeCue.element) : yFor(sIdx);
          // Second spring on pixels so jumps (into a pause, or catching up) glide instead of snap.
          const pw = 4.5;
          pVel += (pw * pw * (targetY - position) - 2 * pw * pVel) * dt;
          setScroll(position + pVel * dt);
          status(activeCue ? (audio && audio.level.voice ? 'Waiting for quiet before the silence counts down.' : 'Hold the silence…') : cursor === 0 ? 'Listening… start reading and the script will follow your words.' : 'Following your words.');
        } else if (activeCue) {
          // With the mic on, a silence only counts down while the room is actually quiet.
          if (!hearing || !audio.level.voice) activeCue.remaining = Math.max(0, activeCue.remaining - dt * speed / 40);
          if (activeCue.remaining === 0) { completedCues.add(activeCue.index); activeCue = null; goUntil = performance.now() + 900; }
          else status(hearing && audio.level.voice ? 'Waiting for quiet before the silence counts down.' : 'Hold the silence…');
        } else {
          holding = hearing && !audio.level.voice && performance.now() > goUntil;
          // Ease in and out of movement, and slow gently into the next pause.
          let targetVel = holding ? 0 : speed;
          const ahead = cues.find(c => !completedCues.has(c.index) && cuePosition(c) >= position - 1);
          if (ahead && !holding) targetVel = Math.min(targetVel, Math.max(12, (cuePosition(ahead) - position) * 2.5));
          vel += (targetVel - vel) * Math.min(1, dt * 4);
          if (vel > 0.3) {
            const next = cues.find(c => !completedCues.has(c.index) && cuePosition(c) <= position + vel * dt);
            if (next) {
              setScroll(Math.max(position, cuePosition(next)));
              activeCue = next;
              activeCue.remaining = activeCue.seconds;
              vel = 0;
            } else setScroll(position + vel * dt);
          }
          status(hearing ? (holding ? (position < 1 ? 'Listening… start speaking and the script will follow you.' : 'Holding with you. Carry on when you’re ready.') : 'Following your voice.') : 'Reading · your pace, your pauses.');
        }
        if (time - lastTiming > 150) { lastTiming = time; timing(); } else updateCue();
      }
      last = time;
      if (wordsOn ? cursor >= words.length && !activeCue && cues.every(c => completedCues.has(c.index)) : !activeCue && cues.every(c => completedCues.has(c.index)) && viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1) {
        pause('End of script. Restart for another take.');
        endRecording();
        currentTake = null;
        timing();
        return;
      }
      frame = requestAnimationFrame(tick);
    }
    function toggle() {
      if (playing) return pause();
      if (viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1 && !activeCue) restart();
      if (fresh || !currentTake) {
        fresh = false;
        currentTake = { take: takes.length + 1, started: clock(new Date()), length: '00:00', markers: [], input: audio && audio.level.connected ? audio.level.label : '' };
        takes.push(currentTake);
        saveTakes();
        prerollUntil = performance.now() + 3000;
        if (recOn) beginRecording(currentTake);
      }
      position = viewport.scrollTop;
      sIdx = cursor; sVel = 0; vel = 0; pVel = 0; quietSince = 0;
      if (follow && SR && !wordsFailed) { startRecognition(); syncCursor(); }
      playing = true;
      last = null;
      q('[data-p-play]').textContent = 'Pause';
      q('[data-p-play]').setAttribute('aria-pressed', 'true');
      if (!prerollUntil) status(wordsOn ? 'Listening… start reading and the script will follow your words.' : listening() ? 'Listening… start speaking and the script will follow you.' : 'Reading · your pace, your pauses.');
      frame = requestAnimationFrame(tick);
    }
    function mark() {
      if (!currentTake) { status('Start a take before adding a marker.'); return; }
      currentTake.markers.push(`${formatTime(elapsed)} (${clock(new Date())})`);
      saveTakes();
      status(`Marker ${currentTake.markers.length} · take ${currentTake.take} at ${formatTime(elapsed)}`);
      viewport.classList.remove('flash');
      void viewport.offsetWidth;
      viewport.classList.add('flash');
    }
    function takeLogText() {
      const lines = ['THE PROGRAM · TAKE LOG', `Script: ${script ? script.title + ' · v' + script.version : 'Teleprompter draft'}`, `Date: ${today()}`, 'Times are this computer’s clock. Match them to the recorder’s file times.', ''];
      for (const t of takes) lines.push(`Take ${t.take} · started ${t.started} · length ${t.length}${t.input ? ' · mic: ' + t.input : ''}`, ...(t.file ? [`   Backup file: ${t.file}`] : []), ...(t.drive ? [`   Google Drive: ${t.drive}`] : []), ...t.markers.map((m, i) => `   Marker ${i + 1}: ${m}`));
      if (!takes.length) lines.push('No takes recorded yet.');
      return lines.join('\n') + '\n';
    }
    const takeLogName = () => `${script ? (script.piece || 'script') + '_' : ''}take-log_${today()}.txt`;
    function downloadTakes() {
      closeTake();
      const url = URL.createObjectURL(new Blob([takeLogText()], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = takeLogName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function settings() {
      q('[data-p-speed]').value = speed;
      q('[data-p-size]').value = size;
      q('[data-p-speed-label]').textContent = `${speed} px/s`;
      q('[data-p-size-label]').textContent = `${size} px`;
      q('.prompter-text').style.fontSize = `${size}px`;
      rowsDirty = true;
      q('[data-p-follow]').checked = follow;
      measure();
      timing();
    }
    function restart() {
      pause('Back at the beginning. Ready for another take.');
      if (recorder) endRecording();
      viewport.scrollTop = position = 0;
      elapsed = 0; activeCue = null; completedCues.clear(); goUntil = 0;
      fresh = true; currentTake = null;
      cursor = 0; paceLog = []; clearWords();
      sIdx = 0; sVel = 0; vel = 0; settleScroll();
      for (const cue of cues) cue.remaining = cue.seconds;
      timing();
      q('[data-p-play]').textContent = 'Start';
    }
    function read() {
      if (!input.value.trim()) { input.focus(); input.setCustomValidity('Add a script first.'); input.reportValidity(); return; }
      persist();
      editor.hidden = true;
      reader.hidden = false;
      q('[data-p-focus]').hidden = false;
      renderText();
      restart();
      viewport.focus();
    }

    // ---- Microphone ----
    const meterPct = db => `${Math.max(0, Math.min(100, (db + 72) / 72 * 100))}%`;
    function showThreshold() {
      if (!audio) return;
      const auto = audio.prefs.auto, value = auto && audio.level.connected ? audio.level.threshold : audio.prefs.threshold;
      q('[data-p-auto]').checked = auto;
      q('[data-p-threshold]').disabled = auto;
      q('[data-p-threshold]').value = value;
      q('[data-p-threshold-label]').textContent = auto && !audio.level.connected ? 'Auto' : `${value} dB`;
      q('.pa-threshold').style.left = meterPct(value);
    }
    async function fillDevices() {
      if (!audio) return;
      const select = q('[data-p-device]');
      const list = await audio.devices().catch(() => []);
      const wanted = audio.prefs.deviceId;
      const inputs = list.filter(d => d.deviceId && d.deviceId !== 'default');
      select.replaceChildren(new Option('Default input', ''), ...inputs.map((d, i) => new Option(d.label || `Input ${i + 1}`, d.deviceId)));
      const zoom = inputs.find(d => /h2|zoom/i.test(d.label));
      select.value = inputs.some(d => d.deviceId === wanted) ? wanted : zoom ? zoom.deviceId : '';
    }
    function micUi() {
      const on = !!(audio && audio.level.connected);
      reader.classList.toggle('mic-on', on);
      q('[data-p-disconnect]').disabled = !on;
      q('[data-p-calibrate]').disabled = !on;
      if (!on) {
        const light = q('[data-p-voice]');
        light.textContent = 'Mic off'; light.dataset.state = 'off';
        q('[data-p-db]').textContent = '— dB';
        q('.pa-fill').style.clipPath = 'inset(0 100% 0 0)';
        q('.pa-peak').style.left = '0%';
        q('.prompter-audio').classList.remove('hot');
      }
    }
    async function connectMic(deviceId) {
      if (!audio || !audio.supported()) { status('This browser can’t use a microphone here. Try Chrome or Safari on a secure (https) page.'); return; }
      status('Connecting to the microphone…');
      try {
        await audio.connect(deviceId);
        await fillDevices();
        micUi();
        status(`Listening to ${audio.level.label}. Nothing is recorded here — the recorder keeps the take.`);
      } catch (error) {
        micUi();
        status(error.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser’s site settings, then try again.' : error.name === 'NotFoundError' ? 'No microphone found. Check the USB cable and that the recorder is set up as an audio interface.' : 'Couldn’t open that microphone. Check the connection and try again.');
      }
    }
    const offAudio = audio ? audio.on((type, level) => {
      if (type === 'frame') {
        q('.pa-fill').style.clipPath = `inset(0 ${100 - parseFloat(meterPct(level.rms))}% 0 0)`;
        q('.pa-peak').style.left = meterPct(level.peakHold);
        q('[data-p-db]').textContent = `${level.peakHold > -99 ? Math.round(level.peakHold) : '—'} dB`;
        const light = q('[data-p-voice]');
        const state = level.voice ? 'voice' : 'quiet';
        if (light.dataset.state !== state) { light.dataset.state = state; light.textContent = level.voice ? 'Speaking' : 'Quiet'; }
        q('.prompter-audio').classList.toggle('hot', level.hot);
        if (audio.prefs.auto) showThreshold();
        q('.prompter-vu span').style.clipPath = `inset(${100 - parseFloat(meterPct(level.rms))}% 0 0 0)`;
        q('.prompter-vu i').style.bottom = meterPct(level.threshold);
        q('.prompter-vu').classList.toggle('voice', level.voice);
        if (!playing) updateCue();
      } else if (type === 'lost') {
        micUi();
        if (recorder) endRecording();
        if (playing && follow) pause('Microphone disconnected. Check the USB cable, then reconnect.');
        else status('Microphone disconnected. Check the USB cable, then reconnect.');
      } else if (type === 'devices') fillDevices();
      else if (type === 'calibrated') showThreshold();
    }) : () => {};
    q('[data-p-connect]').onclick = () => connectMic(q('[data-p-device]').value);
    q('[data-p-disconnect]').onclick = async () => { if (recorder) await endRecording(); if (audio && audio.level.connected) { audio.disconnect(); micUi(); status('Microphone disconnected.'); } };
    q('[data-p-device]').onchange = event => { if (audio && audio.level.connected) connectMic(event.target.value); else if (audio) audio.prefs.deviceId = event.target.value; };
    q('[data-p-calibrate]').onclick = async () => {
      if (playing) pause();
      const button = q('[data-p-calibrate]');
      button.disabled = true;
      status('Listening to the room for 3 seconds — please stay quiet…');
      try {
        const { floor, threshold } = await audio.calibrate();
        status(`Room tone ${floor} dB. Speaking now registers above ${threshold} dB.`);
      } catch (error) { status(error.message); }
      button.disabled = !audio.level.connected;
    };
    q('[data-p-threshold]').oninput = event => { if (audio) { audio.setThreshold(event.target.value); showThreshold(); } };
    q('[data-p-auto]').onchange = event => { if (audio) { audio.setAuto(event.target.checked); showThreshold(); status(event.target.checked ? 'Trigger is automatic: anything clearly louder than the room counts as speaking.' : 'Trigger is manual: drag it so speaking sits to the right of the gold mark.'); } };
    q('[data-p-follow]').onchange = event => {
      follow = event.target.checked;
      persist();
      if (!follow && rec) stopRecognition();
      else if (follow && playing && SR && !wordsFailed) { startRecognition(); syncCursor(); }
      modeLabel();
      if (follow && !(audio && audio.level.connected)) connectMic(q('[data-p-device]').value);
      else status(follow ? 'Follow my voice is on. The script moves while you speak and waits while you pause.' : 'Follow my voice is off. The script scrolls at a steady speed.');
    };

    // ---- Backup recording to a folder ----
    let folder = null, recorder = null;
    const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return { day: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`, time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` }; };
    function takeFileName(take) {
      const { day, time } = stamp();
      const id = (script && script.piece && script.piece !== 'DEMO' ? script.piece : 'TP').replace(/[^A-Za-z0-9-]/g, '');
      return `${id}_${day}_take${String(take.take).padStart(2, '0')}_${time}.wav`;
    }
    function recUi() {
      q('[data-p-rec-on]').checked = recOn;
      q('[data-p-folder]').hidden = !canPickFolder;
      q('[data-p-folder]').textContent = folder ? 'Change folder…' : 'Choose folder…';
      q('[data-p-folder-name]').textContent = canPickFolder ? (folder ? folder.name : 'No folder chosen') : '';
      q('[data-p-rec-note]').textContent = canPickFolder
        ? 'Saves a 24-bit WAV of the mic feed for every take, plus the take log. The H2 still keeps its own recording.'
        : 'This browser can’t write to a folder, so each take downloads as a WAV when it ends. Use Chrome to save straight to a folder.';
      const drive = !!(window.HubDrive && HubDrive.connected());
      q('[data-p-drive-row]').hidden = !drive;
      q('[data-p-drive]').checked = driveUp;
      q('[data-p-rec]').hidden = !recorder;
      if (!recorder) q('[data-p-rec]').textContent = '';
    }
    async function pickFolder() {
      try { folder = await window.showDirectoryPicker({ id: 'program-takes', mode: 'readwrite' }); saveFolder(folder); recUi(); return true; }
      catch { return false; }
    }
    function fileTarget(writable, handle) {
      return { write: bytes => writable.write(bytes), async finish(header) { await writable.write({ type: 'write', position: 0, data: header }); await writable.close(); }, blob: () => handle.getFile() };
    }
    function downloadTarget(name) {
      const chunks = [];
      return {
        async write(bytes) { chunks.push(bytes); },
        async finish(header) {
          chunks[0] = header;
          const file = new Blob(chunks, { type: 'audio/wav' });
          this.blob = async () => file;
          const url = URL.createObjectURL(file);
          const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        },
      };
    }
    async function writeLogToFolder() {
      if (!folder) return;
      try { const w = await (await folder.getFileHandle(takeLogName(), { create: true })).createWritable(); await w.write(takeLogText()); await w.close(); } catch {}
    }
    async function beginRecording(take) {
      const name = takeFileName(take);
      try {
        // Folder permission first, while the Start press still counts as a user action.
        if (canPickFolder && !folder && !(await pickFolder())) throw new Error('no folder chosen');
        if (folder && (await folder.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await folder.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('folder access wasn’t allowed');
        if (!(audio && audio.level.connected)) await connectMic(q('[data-p-device]').value);
        if (!(audio && audio.level.connected)) throw new Error('the microphone isn’t connected');
        const handle = folder ? await folder.getFileHandle(name, { create: true }) : null;
        const target = handle ? fileTarget(await handle.createWritable(), handle) : downloadTarget(name);
        if (take !== currentTake) { await target.finish(new Uint8Array(44)).catch(() => {}); return; }
        recorder = await audio.startRecording(target);
        recorder.take = take;
        recorder.target = target;
        recorder.name = name;
        take.file = folder ? `${folder.name}/${name}` : `Downloads/${name}`;
        saveTakes();
        recUi();
      } catch (error) {
        recorder = null;
        recUi();
        status(`Not recording a backup: ${error.message}.`);
      }
    }
    async function endRecording() {
      const r = recorder;
      recorder = null;
      recUi();
      if (!r) return;
      try {
        const result = await r.stop();
        status(`Saved take ${r.take.take} backup · ${formatTime(result.seconds)} · ${r.take.file}`);
        if (driveUp && window.HubDrive && HubDrive.connected() && r.target.blob) uploadTake(r);
      } catch (error) {
        status(`The backup for take ${r.take.take} couldn’t be saved (${error.message}). The H2 still has its recording.`);
      }
      closeTake();
      writeLogToFolder();
    }
    q('[data-p-rec-on]').onchange = async event => {
      recOn = event.target.checked;
      persist();
      if (recOn && canPickFolder && !folder) await pickFolder();
      if (!recOn && recorder) await endRecording();
      else if (recOn && playing && currentTake && !recorder) beginRecording(currentTake);
      recUi();
    };
    q('[data-p-folder]').onclick = () => pickFolder();
    q('[data-p-drive]').onchange = event => { driveUp = event.target.checked; persist(); };
    async function uploadTake(r) {
      const take = r.take;
      try {
        const blob = await r.target.blob();
        const file = await HubDrive.upload(blob, { name: r.name, type: 'audio/wav', folder: '01_Incoming', onProgress: p => { if (p < 1) status(`Uploading take ${take.take} to Google Drive… ${Math.round(p * 100)}%`); } });
        take.drive = file.link;
        saveTakes();
        HubDrive.addFile(file, { source: 'Teleprompter', take: take.take, script: script ? script.title : 'Teleprompter draft' });
        status(`Take ${take.take} is in Google Drive · ${file.folder}`);
        writeLogToFolder();
      } catch (error) {
        status(`Take ${take.take} is saved on this computer but didn’t reach Google Drive (${error.message}).`);
      }
    }
    loadFolder().then(handle => { if (handle && !folder) { folder = handle; recUi(); } });
    const recTimer = setInterval(() => { if (recorder) q('[data-p-rec]').textContent = `REC ${formatTime(recorder.seconds)}`; }, 500);

    // ---- Editor + controls ----
    input.oninput = () => {
      input.setCustomValidity('');
      // Keep marks outside an edit and discard only marks whose words changed.
      let prefix = 0, suffix = 0;
      while (prefix < previousText.length && prefix < input.value.length && previousText[prefix] === input.value[prefix]) prefix++;
      while (suffix < previousText.length - prefix && suffix < input.value.length - prefix && previousText[previousText.length - suffix - 1] === input.value[input.value.length - suffix - 1]) suffix++;
      const delta = input.value.length - previousText.length;
      ranges = ranges.flatMap(([start, end]) => end <= prefix ? [[start, end]] : start >= previousText.length - suffix ? [[start + delta, end + delta]] : []);
      previousText = input.value;
      persist();
    };
    q('[data-p-insert-gap]').onclick = () => {
      const seconds = Number(q('[data-p-gap]').value);
      if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 300) { q('[data-p-gap]').reportValidity(); return; }
      const start = input.selectionStart;
      const cue = `\n[SILENCE: ~${seconds} SECONDS]\n`;
      input.setRangeText(cue, start, start, 'end');
      input.oninput();
      input.focus();
    };
    q('[data-p-highlight]').onclick = () => {
      if (!highlight(input.selectionStart, input.selectionEnd)) {
        q('[data-p-saved]').textContent = 'Select the words you want to emphasize first.';
        input.focus();
      } else q('[data-p-saved]').textContent = 'Emphasis added. Open the reader to see your highlighted words.';
    };
    q('[data-p-clear]').onclick = clearEmphasis;
    q('[data-p-reader-clear]').onclick = () => { pause(); clearEmphasis(); };
    let readerSelection = null;
    function captureSelection() {
      const selection = window.getSelection();
      const text = q('.prompter-text');
      if (!selection.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!text.contains(range.startContainer) || !text.contains(range.endContainer)) return;
      const before = document.createRange();
      before.selectNodeContents(text);
      before.setEnd(range.startContainer, range.startOffset);
      readerSelection = [before.toString().length, before.toString().length + range.toString().length];
    }
    viewport.addEventListener('pointerup', captureSelection);
    viewport.addEventListener('keyup', captureSelection);
    q('[data-p-reader-highlight]').onpointerdown = captureSelection;
    q('[data-p-reader-highlight]').onclick = () => {
      pause();
      captureSelection();
      if (!readerSelection || !highlight(...readerSelection)) status('Select words in the reader, then choose Highlight selection.');
      else status('Emphasis added. Resume whenever you are ready.');
      readerSelection = null;
    };
    q('[data-p-read]').onclick = read;
    q('[data-p-play]').onclick = toggle;
    q('[data-p-restart]').onclick = restart;
    q('[data-p-mark]').onclick = mark;
    q('[data-p-takes]').onclick = downloadTakes;
    q('[data-p-edit]').onclick = () => { pause(); if (recorder) endRecording(); setFocus(false); reader.hidden = true; editor.hidden = false; q('[data-p-focus]').hidden = true; input.focus(); };
    q('[data-p-close]').onclick = () => dialog.close();
    const drawer = q('.prompter-drawer');
    function setDrawer(open) { drawer.hidden = !open; q('[data-p-settings]').setAttribute('aria-expanded', String(open)); q('[data-p-settings]').classList.toggle('active', open); measure(); if (!playing) syncCues(); }
    function setFocus(on) { dialog.classList.toggle('focus', on); q('[data-p-focus]').setAttribute('aria-pressed', String(on)); if (on) setDrawer(false); measure(); if (!playing) syncCues(); viewport.focus(); }
    q('[data-p-settings]').onclick = () => setDrawer(drawer.hidden);
    q('[data-p-focus]').onclick = () => setFocus(true);
    q('[data-p-unfocus]').onclick = () => setFocus(false);
    q('[data-p-speed]').oninput = event => { speed = Number(event.target.value); settings(); persist(); };
    q('[data-p-size]').oninput = event => { pause(); size = Number(event.target.value); settings(); syncCues(); persist(); };
    for (const event of ['wheel', 'touchstart', 'pointerdown']) viewport.addEventListener(event, () => { if (playing) pause(); }, { passive: true });
    viewport.addEventListener('scroll', () => { if (!playing && Math.abs(position - viewport.scrollTop) > 1) { position = viewport.scrollTop; syncCues(); } });
    dialog.addEventListener('keydown', event => {
      if (reader.hidden || event.target.matches('input:not([type=checkbox]):not([type=range]), textarea, select') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) toggle(); }
      else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); speed = Math.min(120, Math.max(10, speed + (event.key === 'ArrowRight' ? 5 : -5))); settings(); persist(); }
      else if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); pause(); viewport.scrollTop += event.key === 'ArrowUp' ? -120 : 120; }
      else if (event.key === 'Home') { event.preventDefault(); restart(); }
      else if (event.key.toLowerCase() === 'm' && !event.repeat) { event.preventDefault(); mark(); }
      else if (event.key.toLowerCase() === 'h' && !event.repeat) { event.preventDefault(); setFocus(!dialog.classList.contains('focus')); }
      else if (event.key.toLowerCase() === 'f' && !event.repeat) { event.preventDefault(); const box = q('[data-p-follow]'); box.checked = !box.checked; box.onchange({ target: box }); }
    });
    const onVisibility = () => { if (document.hidden && playing) pause(); };
    document.addEventListener('visibilitychange', onVisibility);
    const onResize = () => { measure(); rowsDirty = true; if (!playing) syncCues(); };
    window.addEventListener('resize', onResize);
    dialog.addEventListener('close', () => {
      pause();
      stopRecognition();
      offAudio();
      clearInterval(recTimer);
      endRecording().finally(() => { if (audio) audio.disconnect(true); });
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      dialog.remove();
    }, { once: true });
    showThreshold();
    micUi();
    recUi();
    fillDevices();
    settings();
    modeLabel();
    dialog.showModal();
    if (script) read(); else input.focus();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'teleprompter') open();
    if (button.dataset.prompterScript) {
      const script = state.scripts.find(item => item.id === button.dataset.prompterScript && item.status === 'Approved');
      if (script) open(script);
    }
  });
})();
