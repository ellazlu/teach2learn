// Avatar frames: your hand-drawn images in public/avatar/, listed in
// public/avatar/avatar.json. Any frame that isn't drawn yet falls back
// (to the listening frame, or to the built-in placeholder if there is no art).

export const AVATAR_DIR = '/avatar';
export const FRAME_NAMES = ['listening', 'listening-blink', 'curious', 'confused', 'understanding', 'challenging', 'talking-1', 'talking-2'];

// Turn the manifest into { frameName: url } for the frames it lists.
export function framesFromManifest(manifest) {
  const format = String(manifest?.format || 'png').replace(/^\./, '');
  const out = {};
  for (const entry of manifest?.frames || []) {
    const file = String(entry);
    const name = file.replace(/\.(png|webp|svg|jpe?g|gif)$/i, '');
    if (!FRAME_NAMES.includes(name)) continue;
    out[name] = `${AVATAR_DIR}/${file.includes('.') ? file : `${file}.${format}`}`;
  }
  return out;
}

// Which image to show right now (null = use the built-in placeholder).
//   behavior: listening | curious | confused | understanding | challenging | responding
//   talkFrame: 0/1, alternated while the student is speaking
export function pickFrame(frames, behavior, talkFrame = 0, blink = false) {
  if (!frames?.listening) return null; // the base frame is required
  if (behavior === 'responding') {
    // Alternate mouth shapes: talking-1 / talking-2 (or talking-1 / listening = open / closed).
    if (!frames['talking-1']) return frames.listening;
    return talkFrame ? frames['talking-2'] || frames.listening : frames['talking-1'];
  }
  if (blink && behavior === 'listening' && frames['listening-blink']) return frames['listening-blink'];
  return frames[behavior] || frames.listening;
}

let loading = null;

// Load the manifest once and preload every listed image (so swaps never flicker).
// Images that fail to load are dropped, so they fall back instead of showing broken.
export function loadFrames() {
  loading ??= fetch(`${AVATAR_DIR}/avatar.json`, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : { frames: [] }))
    .catch(() => ({ frames: [] }))
    .then(async (manifest) => {
      const frames = framesFromManifest(manifest);
      const ok = await Promise.all(
        Object.entries(frames).map(
          ([name, url]) =>
            new Promise((resolve) => {
              const img = new Image();
              img.onload = () => resolve([name, url]);
              img.onerror = () => resolve(null);
              img.src = url;
            })
        )
      );
      return Object.fromEntries(ok.filter(Boolean));
    });
  return loading;
}
