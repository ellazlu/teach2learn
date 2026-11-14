# Avatar art

Each level can have its own character:

```
public/avatar/
├── avatar.json            ← shared default character (used by any level without its own art)
├── kindergarten/avatar.json
├── middle/avatar.json
├── high/avatar.json
├── college/avatar.json
└── expert/avatar.json
```

Put a character's frames in its folder and list them in that folder's `avatar.json`.
A level uses its own character as soon as its folder has a `listening` frame; until then it
uses the shared default (this folder), and with no art at all, the built-in placeholder face.
Characters are never mixed: a missing expression falls back to the same character's
`listening` frame.

## Frames

| File | Shown when | Draw |
|---|---|---|
| `listening` | default, while you teach (**required** — the base frame) | neutral, attentive |
| `listening-blink` | flashed every few seconds | same pose, eyes closed |
| `curious` | it heard something new | raised brows, leaning in |
| `confused` | an explanation didn't make sense | puzzled, tilted head |
| `understanding` | something clicked | happy, "aha" |
| `challenging` | an advanced student pushes back | skeptical, one brow up |
| `talking-1` | while its voice plays (alternates with `talking-2`) | mouth open |
| `talking-2` | while its voice plays | mouth half-open (if missing, alternates with `listening`) |

Fallbacks: any missing expression shows `listening`; with no `listening` frame, the built-in placeholder face is used.

## Export specs
- Same square canvas for every frame (1024×1024), character in exactly the same position.
  Tip: draw expressions as layers over one base drawing and export each.
- Transparent background, nothing baked in.
- PNG or WebP, ideally under ~200 KB each.

## avatar.json

```json
{
  "format": "png",
  "frames": ["listening", "listening-blink", "curious", "confused", "understanding", "challenging", "talking-1", "talking-2"]
}
```

`format` is the file extension used for names without one. You can also list full file names (e.g. `"confused.webp"`) to mix formats.
