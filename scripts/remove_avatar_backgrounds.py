"""Make the white background of the avatar PNGs transparent.

Only white that is connected to the image edge is removed, so white or cream
areas inside a character (bellies, eye highlights) are kept. Edge pixels are
un-blended from white so there is no pale halo on coloured backgrounds.

Usage: python3 scripts/remove_avatar_backgrounds.py [public/avatar]
Safe to run again: files that already have transparency are skipped.
"""
import glob, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

WHITE = 244   # every channel at least this = background-coloured
FRINGE = 2    # pixels of anti-aliased edge to un-blend
# Background that is fully enclosed by the drawing (not reachable from the edge).
# Folder -> enclosed pure-white areas starting below this y (in a 1024px frame)
# are background too. The octopus has gaps between its tentacles; its head shine
# and eye highlights sit higher up and are kept.
HOLES_BELOW = {'expert': 600}


def cut(path):
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im).astype(np.float32)
    if a[..., 3].min() < 255:
        return False  # already has transparency
    rgb = a[..., :3]
    whiteish = rgb.min(axis=2) >= WHITE
    labels, _ = ndi.label(whiteish)
    edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    bg = np.isin(labels, edge[edge > 0])
    below = HOLES_BELOW.get(os.path.basename(os.path.dirname(path)))
    if below is not None:
        holes, _ = ndi.label((rgb.min(axis=2) >= 250) & ~bg)
        for i, sl in enumerate(ndi.find_objects(holes), 1):
            if sl[0].start >= below * a.shape[0] / 1024 and (holes[sl] == i).sum() >= 20:
                bg |= holes == i

    fringe = ndi.binary_dilation(bg, iterations=FRINGE) & ~bg
    solid = ~ndi.binary_dilation(bg, iterations=FRINGE + 1)
    # Each fringe pixel takes the colour of the nearest solid pixel; its alpha is
    # how far it sits between white and that colour.
    idx = ndi.distance_transform_edt(~solid, return_distances=False, return_indices=True)
    fg = rgb[idx[0], idx[1]]
    num = ((255 - rgb) * (255 - fg)).sum(axis=2)
    den = ((255 - fg) ** 2).sum(axis=2)
    alpha = np.clip(num / np.maximum(den, 1), 0, 1)
    alpha = np.where(den < 300, 1.0, alpha)  # the character itself is near-white here: keep it

    out = a.copy()
    out[fringe, :3] = fg[fringe]
    out[fringe, 3] = alpha[fringe] * 255
    out[bg, 3] = 0
    out[bg, :3] = 255
    Image.fromarray(out.round().astype(np.uint8), 'RGBA').save(path, optimize=True)
    return True


if __name__ == '__main__':
    root = sys.argv[1] if len(sys.argv) > 1 else 'public/avatar'
    for f in sorted(glob.glob(f'{root}/**/*.png', recursive=True)):
        print(('cut   ' if cut(f) else 'skip  ') + f)
