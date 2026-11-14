// Avatar frames: your hand-drawn images, one character per level.
//   public/avatar/<level>/avatar.json  -> that level's character (kindergarten, middle, high, college, expert)
//   public/avatar/avatar.json          -> shared default character
// A level uses its own set once it has a `listening` frame; otherwise the
// shared set; otherwise the built-in placeholder. Sets are never mixed, so one
// character's face never shows up on another. Within a set, a missing
// expression falls back to that set's listening frame.

export const AVATAR_DIR = '/avatar';
export const FRAME_NAMES = ['listening', 'listening-blink', 'curious', 'confused', 'understanding', 'challenging', 'talking-1', 'talking-2'];

export const LEVEL_IDS = ['kindergarten', 'middle', 'high', 'college', 'expert'];

// Turn a manifest into { frameName: url } for the frames it lists.
export function framesFromManifest(manifest, dir = AVATAR_DIR) {
  const format = String(manifest?.format || 'png').replace(/^\./, '');
  const out = {};
  for (const entry of manifest?.frames || []) {
    const file = String(entry);
    const name = file.replace(/\.(png|webp|svg|jpe?g|gif)$/i, '');
    if (!FRAME_NAMES.includes(name)) continue;
    out[name] = `${dir}/${file.includes('.') ? file : `${file}.${format}`}`;
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

// The level's own character if it has art, else the shared one, else none.
export function chooseSet(levelFrames, defaultFrames) {
  if (levelFrames?.listening) return levelFrames;
  if (defaultFrames?.listening) return defaultFrames;
  return {};
}

// Load a manifest and preload its images; frames that fail to load are dropped.
async function loadSet(dir) {
  const manifest = await fetch(`${dir}/avatar.json`, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : { frames: [] }))
    .catch(() => ({ frames: [] }));
  const frames = framesFromManifest(manifest, dir);
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
}

const cache = new Map();
const cached = (dir) => {
  if (!cache.has(dir)) cache.set(dir, loadSet(dir));
  return cache.get(dir);
};

// Frames for a level's character (falls back to the shared set).
export function loadFrames(levelId) {
  const own = LEVEL_IDS.includes(levelId) ? cached(`${AVATAR_DIR}/${levelId}`) : Promise.resolve({});
  return Promise.all([own, cached(AVATAR_DIR)]).then(([l, d]) => chooseSet(l, d));
}
