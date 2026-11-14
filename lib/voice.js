// The student's voice.
//   ElevenLabs (if ELEVENLABS_API_KEY is set): each sentence's audio is fetched
//   the moment the sentence is written, and sentences play back-to-back, so the
//   next one is usually ready before the current one ends.
//   Browser fallback: picks the most natural local voice available (neural /
//   "Natural" / "Online" / Google voices) instead of the robotic default.

let providerPromise = null;
export function detectProvider() {
  providerPromise ??= fetch('/api/tts')
    .then((r) => r.json())
    .then((j) => (j.provider === 'elevenlabs' ? 'elevenlabs' : 'browser'))
    .catch(() => 'browser');
  return providerPromise;
}

// Higher score = more natural sounding.
export function scoreVoice(v) {
  if (!v || !/^en/i.test(v.lang || '')) return -1;
  const n = v.name || '';
  let s = 0;
  if (/natural|neural/i.test(n)) s += 6;
  if (/online/i.test(n)) s += 3;
  if (/premium|enhanced/i.test(n)) s += 4;
  if (/google/i.test(n)) s += 3;
  if (/(ava|samantha|allison|aria|jenny|emma|michelle|zoe)/i.test(n)) s += 2;
  if (/en[-_]US/i.test(v.lang)) s += 1;
  if (/(compact|espeak|novelty|whisper|bad news|bells|zarvox|trinoids|albert|jester)/i.test(n)) s -= 10;
  return s;
}

export function bestBrowserVoice() {
  const voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
  return [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
}

export function createPlayer({ level, now, onError }) {
  let provider = 'browser';
  detectProvider().then((p) => (provider = p));
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.getVoices(); // start loading voices early

  let chain = Promise.resolve();
  let generation = 0;
  let stopCurrent = null;

  const fetchAudio = (text) =>
    fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, levelId: level.id }) }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `TTS ${r.status}`);
      return r.blob();
    });

  const playBlob = (blob) =>
    new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      let start = now();
      const done = () => {
        URL.revokeObjectURL(url);
        stopCurrent = null;
        resolve({ start, end: now() });
      };
      stopCurrent = () => {
        a.pause();
        done();
      };
      a.onplaying = () => (start = now());
      a.onended = done;
      a.onerror = done;
      a.play().catch(done);
    });

  const playBrowser = (text) =>
    new Promise((resolve) => {
      let start = now();
      if (typeof speechSynthesis === 'undefined') return resolve({ start, end: start });
      const u = new SpeechSynthesisUtterance(text);
      const v = bestBrowserVoice();
      if (v) u.voice = v;
      u.lang = v?.lang || 'en-US';
      u.pitch = level.voice.pitch;
      u.rate = level.voice.rate;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(safety);
        stopCurrent = null;
        resolve({ start, end: now() });
      };
      stopCurrent = () => {
        speechSynthesis.cancel();
        done();
      };
      u.onstart = () => (start = now());
      u.onend = done;
      u.onerror = done;
      const safety = setTimeout(done, 2500 + text.split(/\s+/).length * 450); // some browsers never fire onend
      speechSynthesis.speak(u);
    });

  return {
    get provider() {
      return provider;
    },
    // Queue a sentence. `gate` resolves when it's OK to start (mic paused).
    sentence(text, gate = Promise.resolve()) {
      const gen = generation;
      const audio = provider === 'elevenlabs' ? fetchAudio(text).catch((e) => (onError?.(e.message), null)) : null; // prefetch now
      const p = Promise.all([chain, gate]).then(async () => {
        if (gen !== generation) return { start: now(), end: now() };
        const blob = audio ? await audio : null;
        if (gen !== generation) return { start: now(), end: now() };
        return blob ? playBlob(blob) : playBrowser(text);
      });
      chain = p.catch(() => {});
      return p;
    },
    // Stop everything queued or playing.
    cancel() {
      generation++;
      stopCurrent?.();
      try {
        speechSynthesis.cancel();
      } catch {}
    },
  };
}
