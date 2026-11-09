(() => {
  const storageKey = 'program-teleprompter-v1';
  let draft = '', speed = 40, size = 44;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    draft = typeof saved.text === 'string' ? saved.text : '';
    speed = Math.min(120, Math.max(10, Number(saved.speed) || 40));
    size = Math.min(80, Math.max(24, Number(saved.size) || 44));
  } catch {}
  function open(script) {
    if (document.querySelector('.prompter')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'prompter';
    dialog.setAttribute('aria-labelledby', 'prompter-title');
    dialog.innerHTML = `<header class="prompter-header"><div><div class="eyebrow">YOUR WORDS. YOUR PACE.</div><h2 id="prompter-title">Teleprompter</h2></div><button class="btn" data-p-close>Close ×</button></header>
      <section class="prompter-editor"><label for="prompter-input">Add your script</label><p class="small muted">Paste your words below. Keep line breaks and pause cues wherever you need a breath.</p><textarea id="prompter-input" placeholder="Paste or type your script here…"></textarea><p class="small muted" data-p-saved>Saved in this browser only.</p><button class="btn primary" data-p-read>Open reader →</button></section>
      <section class="prompter-reader" hidden><div class="prompter-controls"><button class="btn primary" data-p-play>Start</button><button class="btn" data-p-restart>Restart</button><button class="btn" data-p-edit>Edit script</button><label>Speed <input type="range" min="10" max="120" step="5" data-p-speed aria-label="Scroll speed"><output data-p-speed-label></output></label><label>Text size <input type="range" min="24" max="80" step="2" data-p-size aria-label="Text size"><output data-p-size-label></output></label></div><p class="prompter-help">Space: pause / resume · ← / →: pace · ↑ / ↓: move back / forward · Home: restart · Esc: close</p><div class="prompter-viewport" tabindex="0" aria-label="Script reader. Use Space to pause or resume."><div class="prompter-text"></div></div><div class="prompter-status" role="status" aria-live="polite">Ready when you are.</div></section>`;
    document.body.append(dialog);
    const q = selector => dialog.querySelector(selector);
    const input = q('textarea'), viewport = q('.prompter-viewport');
    const editor = q('.prompter-editor'), reader = q('.prompter-reader');
    let playing = false, frame = 0, last = null, position = 0;
    input.value = script ? script.body : draft;
    function persist() {
      draft = input.value;
      try {
        localStorage.setItem(storageKey, JSON.stringify({text: draft, speed, size}));
        q('[data-p-saved]').textContent = 'Saved in this browser only.';
      } catch { q('[data-p-saved]').textContent = 'Browser storage unavailable. Keep a copy of your script before closing.'; }
    }
    function pause(message = 'Paused. Take your time.') {
      playing = false;
      cancelAnimationFrame(frame);
      last = null;
      q('[data-p-play]').textContent = 'Resume';
      q('[data-p-play]').setAttribute('aria-pressed', 'false');
      q('.prompter-status').textContent = message;
    }
    function tick(time) {
      if (!playing) return;
      if (last !== null) {
        position += speed * Math.min((time - last) / 1000, 0.1);
        viewport.scrollTop = position;
      }
      last = time;
      if (viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1) {
        pause('End of script. Restart for another take.');
        return;
      }
      frame = requestAnimationFrame(tick);
    }
    function toggle() {
      if (playing) return pause();
      if (viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1) viewport.scrollTop = 0;
      position = viewport.scrollTop;
      playing = true;
      last = null;
      q('[data-p-play]').textContent = 'Pause';
      q('[data-p-play]').setAttribute('aria-pressed', 'true');
      q('.prompter-status').textContent = 'Reading · your pace, your pauses.';
      frame = requestAnimationFrame(tick);
    }
    function settings() {
      q('[data-p-speed]').value = speed;
      q('[data-p-size]').value = size;
      q('[data-p-speed-label]').textContent = `${speed} px/s`;
      q('[data-p-size-label]').textContent = `${size} px`;
      q('.prompter-text').style.fontSize = `${size}px`;
    }
    function restart() {
      pause('Back at the beginning. Ready for another take.');
      viewport.scrollTop = position = 0;
      q('[data-p-play]').textContent = 'Start';
    }
    function read() {
      if (!input.value.trim()) { input.focus(); input.setCustomValidity('Add a script first.'); input.reportValidity(); return; }
      persist();
      q('.prompter-text').textContent = input.value;
      editor.hidden = true;
      reader.hidden = false;
      restart();
      viewport.focus();
    }
    input.oninput = () => { input.setCustomValidity(''); persist(); };
    q('[data-p-read]').onclick = read;
    q('[data-p-play]').onclick = toggle;
    q('[data-p-restart]').onclick = restart;
    q('[data-p-edit]').onclick = () => { pause(); reader.hidden = true; editor.hidden = false; input.focus(); };
    q('[data-p-close]').onclick = () => dialog.close();
    q('[data-p-speed]').oninput = event => { speed = Number(event.target.value); settings(); persist(); };
    q('[data-p-size]').oninput = event => { pause(); size = Number(event.target.value); settings(); persist(); };
    for (const event of ['wheel', 'touchstart', 'pointerdown']) viewport.addEventListener(event, () => pause(), {passive: true});
    viewport.addEventListener('scroll', () => { if (!playing) position = viewport.scrollTop; });
    dialog.addEventListener('keydown', event => {
      if (reader.hidden || event.target.matches('input, textarea, select') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) toggle(); }
      else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); speed = Math.min(120, Math.max(10, speed + (event.key === 'ArrowRight' ? 5 : -5))); settings(); persist(); }
      else if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); pause(); viewport.scrollTop += event.key === 'ArrowUp' ? -120 : 120; }
      else if (event.key === 'Home') { event.preventDefault(); restart(); }
    });
    const onVisibility = () => { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', onVisibility);
    dialog.addEventListener('close', () => { pause(); document.removeEventListener('visibilitychange', onVisibility); dialog.remove(); }, {once: true});
    settings();
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
