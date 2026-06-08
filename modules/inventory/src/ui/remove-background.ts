// Lightweight, dependency-free background remover for garment/product photos.
//
// Most catalog + scan photos sit on a white/plain background — exactly the case
// a flood-fill chroma key nails: BFS from the four edges, knock out every pixel
// connected to the border whose colour is within tolerance of the sampled
// background, and feather the cut edge a touch. Connected-only, so it never
// punches holes inside the garment. Zero deps, fully offline, instant, and
// reliable in headless e2e — unlike a multi-MB WASM segmentation model (that's
// the "smart cutout for busy backgrounds" upgrade noted in BACKLOG).
//
// Returns a transparent PNG Blob, or null if it can't help (no clear plain
// background → leave the original alone).

export async function cutoutPlainBackground(
  src: Blob | string,
  opts: { tolerance?: number } = {},
): Promise<Blob | null> {
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;

    // Sample the background from the four corners (median-ish: average the
    // corners that agree). If the corners disagree wildly, the photo has no
    // plain background → bail.
    const corners = [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],
    ].map(([x, y]) => sample(px, w, x!, y!));
    const bg = avg(corners);
    const spread = Math.max(...corners.map((c) => dist(c, bg)));
    if (spread > 60) return null; // corners disagree → not a plain background

    const tol = opts.tolerance ?? 42;
    const visited = new Uint8Array(w * h);
    const stack: number[] = [];
    // Seed from every border pixel.
    for (let x = 0; x < w; x++) {
      pushIfBg(x, 0);
      pushIfBg(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      pushIfBg(0, y);
      pushIfBg(w - 1, y);
    }
    function pushIfBg(x: number, y: number) {
      const i = y * w + x;
      if (visited[i]) return;
      if (dist(sample(px, w, x, y), bg) <= tol) {
        visited[i] = 1;
        stack.push(i);
      }
    }
    // BFS over the connected background region.
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i / w) | 0;
      px[i * 4 + 3] = 0; // transparent
      if (x > 0) pushIfBg(x - 1, y);
      if (x < w - 1) pushIfBg(x + 1, y);
      if (y > 0) pushIfBg(x, y - 1);
      if (y < h - 1) pushIfBg(x, y + 1);
    }

    // How much did we remove? If almost nothing (no real background) or almost
    // everything (we ate the garment), don't bother.
    let cleared = 0;
    for (let i = 0; i < w * h; i++) if (visited[i]) cleared++;
    const frac = cleared / (w * h);
    if (frac < 0.04 || frac > 0.97) return null;

    // Feather: soften the alpha of garment-edge pixels that border a hole.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (visited[i] || px[i * 4 + 3] === 0) continue;
        let near = 0;
        if (x > 0 && visited[i - 1]) near++;
        if (x < w - 1 && visited[i + 1]) near++;
        if (y > 0 && visited[i - w]) near++;
        if (y < h - 1 && visited[i + w]) near++;
        if (near) px[i * 4 + 3] = Math.min(px[i * 4 + 3]!, 255 - near * 40);
      }
    }

    ctx.putImageData(data, 0, 0);
    return await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  } catch {
    return null;
  } finally {
    if (typeof src !== "string") URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("image load failed"));
    im.src = url;
  });
}
function sample(px: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number] {
  const i = (y * w + x) * 4;
  return [px[i]!, px[i + 1]!, px[i + 2]!];
}
function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}
function avg(cs: [number, number, number][]): [number, number, number] {
  const s = cs.reduce<[number, number, number]>((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0]);
  return [s[0] / cs.length, s[1] / cs.length, s[2] / cs.length];
}
