// Saved sessions live in the browser's localStorage, so they survive a page
// refresh but stay on this device/browser. Uploaded files are NOT saved (too
// big), only the plan, notes, transcript, and grade.

const KEY = 'teach2learn-history-v1';
export const MAX_HISTORY = 50;

export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Returns false if nothing could be saved. If storage is full, drops the
// oldest sessions until it fits.
export function saveHistory(list) {
  for (let n = list.length; n >= 0; n--) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(0, n)));
      return n === list.length;
    } catch {
      // keep trimming
    }
  }
  return false;
}

// All sessions taught from the same prepared plan, oldest first.
export function attemptsFor(history, entry) {
  return history
    .filter((e) => e.planId === entry.planId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
