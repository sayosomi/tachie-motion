import { useCallback, useEffect, useState } from "react";
import type { Layer } from "./LayerTree";
import type { Visibility } from "./presetModel";

type AssetRow = Visibility & {
  kind: string; rect: [number, number, number, number] | null;
  png: string | null;
};
type AssetResponse = {
  supported: boolean; width?: number; height?: number;
  source_width?: number; source_height?: number; source_identity?: string;
  layers?: AssetRow[];
};

export class PreviewSourceChangedError extends Error {
  constructor() { super("PSDが外部で変更されました。再読み込みしてください。"); }
}

export type BrowserPreviewRenderer = {
  render: (states: readonly Visibility[]) => Promise<string>;
};

type Snapshot = {
  path: string; fingerprint: string; sourceIdentity: string;
  layers: readonly Layer[];
};
type Ready = Snapshot & { renderer: BrowserPreviewRenderer };
const matches = (a: Snapshot, b: Snapshot) =>
  a.path === b.path && a.fingerprint === b.fingerprint
  && a.sourceIdentity === b.sourceIdentity && a.layers === b.layers;

function validateAssets(
  data: AssetResponse, source: readonly Layer[], sourceWidth: number,
  sourceHeight: number, sourceIdentity: string,
): AssetRow[] {
  if (!Number.isInteger(data.width) || !Number.isInteger(data.height)
    || !data.width || !data.height || data.width > 900 || data.height > 900
    || data.source_width !== sourceWidth || data.source_height !== sourceHeight
    || data.source_identity !== sourceIdentity
    || !Array.isArray(data.layers) || data.layers.length !== source.length) {
    throw new Error("Invalid browser-preview asset snapshot");
  }
  for (let i = 0; i < source.length; i++) {
    const row = data.layers[i], original = source[i];
    if (!row || row.path !== original.path || row.kind !== original.kind
      || row.visible !== original.visible || typeof row.visible !== "boolean"
      || !["group", "pixel"].includes(row.kind)) {
      throw new Error("Browser-preview layer snapshot mismatch");
    }
    if (row.kind === "group") {
      if (row.png !== null || row.rect !== null) {
        throw new Error("Group unexpectedly contains a layer bitmap");
      }
      continue;
    }
    const box = original.bbox;
    if (!Array.isArray(box) || box.length !== 4
        || !box.every(Number.isInteger)) throw new Error("Invalid source layer bbox");
    const [left, top, right, bottom] = box;
    const clipped = [
      Math.max(0, left), Math.max(0, top),
      Math.min(sourceWidth, right), Math.min(sourceHeight, bottom),
    ];
    const hasPixels = clipped[0] < clipped[2] && clipped[1] < clipped[3];
    // Off-canvas / empty layers legitimately have neither image nor bounds.
    // Every in-canvas pixel layer MUST have both; partial assets are unsafe.
    if (!hasPixels) {
      if (row.png !== null || row.rect !== null)
        throw new Error("Empty or off-canvas layer unexpectedly has an image");
      continue;
    }
    const scaled = [
      Math.round(clipped[0] * data.width / sourceWidth),
      Math.round(clipped[1] * data.height / sourceHeight),
      Math.round(clipped[2] * data.width / sourceWidth),
      Math.round(clipped[3] * data.height / sourceHeight),
    ];
    const expected = [scaled[0], scaled[1], scaled[2] - scaled[0], scaled[3] - scaled[1]];
    if (expected[2] <= 0 || expected[3] <= 0
        || typeof row.png !== "string" || !row.png.startsWith("data:image/png;base64,")
        || !Array.isArray(row.rect) || row.rect.length !== 4
        || !row.rect.every(Number.isInteger)
        || row.rect.some((value, index) => value !== expected[index])) {
      throw new Error("Missing or inconsistent pixel-layer image");
    }
  }
  return data.layers;
}

function decode(
  data: AssetResponse, source: readonly Layer[], sourceWidth: number,
  sourceHeight: number, sourceIdentity: string,
): Promise<{ render: (states: readonly Visibility[]) => string; dispose: () => void }> {
  const rows = validateAssets(data, source, sourceWidth, sourceHeight, sourceIdentity);
  return (async () => {
    const bitmaps = new Map<string, ImageBitmap>();
    let next = 0;
    let disposed = false;
    const tasks = rows.filter((row) => row.png);
    async function worker() {
      while (next < tasks.length) {
        const row = tasks[next++];
        const response = await fetch(row.png!);
        if (!response.ok) throw new Error("Layer bitmap could not be read");
        const image = await createImageBitmap(await response.blob());
        if (image.width !== row.rect![2] || image.height !== row.rect![3]) {
          image.close();
          throw new Error("Layer bitmap dimensions changed");
        }
        bitmaps.set(row.path, image);
      }
    }
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(6, tasks.length) }, () => worker()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      for (const bitmap of bitmaps.values()) bitmap.close();
      throw (failed as PromiseRejectedResult).reason;
    }
    const canvas = document.createElement("canvas");
    canvas.width = data.width!;
    canvas.height = data.height!;
    const context = canvas.getContext("2d");
    if (!context) {
      for (const bitmap of bitmaps.values()) bitmap.close();
      throw new Error("Canvas 2D is unavailable");
    }
    return {
      render(states: readonly Visibility[]) {
        if (disposed) throw new Error("Browser-preview assets were discarded");
        if (states.length !== rows.length) throw new Error("Incomplete preview state");
        const values = new Map<string, boolean>();
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i], item = states[i];
          if (!item || item.path !== row.path || typeof item.visible !== "boolean")
            throw new Error("Preview layer order mismatch");
          values.set(item.path, item.visible);
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        for (const row of rows) {
          if (!row.png || !row.rect || !values.get(row.path)) continue;
          const segments = row.path.split("/");
          let visible = true;
          for (let i = 1; i < segments.length; i++) {
            if (!values.get(segments.slice(0, i).join("/"))) {
              visible = false;
              break;
            }
          }
          if (visible) context.drawImage(bitmaps.get(row.path)!, row.rect[0], row.rect[1]);
        }
        return canvas.toDataURL("image/png");
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const bitmap of bitmaps.values()) bitmap.close();
        bitmaps.clear();
        canvas.width = 0;
        canvas.height = 0;
      },
    };
  })();
}

export function useBrowserPreview(
  path: string, fingerprint: string, sourceIdentity: string,
  sourceWidth: number, sourceHeight: number, layers: readonly Layer[] | null,
): {
  renderer: BrowserPreviewRenderer | null; sourceChanged: boolean;
  loading: boolean; verifySource: () => Promise<void>;
} {
  const [ready, setReady] = useState<Ready | null>(null);
  const [fallback, setFallback] = useState<Snapshot | null>(null);
  const [invalid, setInvalid] = useState<Snapshot | null>(null);

  // Guard even legacy previews before passing original index paths to Python.
  const verifySource = useCallback(async () => {
    if (!path || !fingerprint || !sourceIdentity || !layers) return;
    let valid = false;
    try {
      const check = await fetch("/api/preview-source-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, fingerprint, source_identity: sourceIdentity }),
      });
      if (check.ok) {
        const result = await check.json() as { valid?: boolean };
        valid = result.valid === true;
      }
    } catch {
      // Unknown is unsafe, even if the bitmap API is unavailable.
    }
    if (!valid) {
      setInvalid({ path, fingerprint, sourceIdentity, layers });
      throw new PreviewSourceChangedError();
    }
  }, [path, fingerprint, sourceIdentity, layers]);

  useEffect(() => {
    if (!path || !fingerprint || !sourceIdentity || !layers) return;
    const controller = new AbortController();
    let cancelled = false;
    let created: Awaited<ReturnType<typeof decode>> | null = null;
    const snapshot = { path, fingerprint, sourceIdentity, layers };
    (async () => {
      try {
        const response = await fetch("/api/preview-layer-assets", {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, fingerprint }),
        });
        if (cancelled) return;
        if (!response.ok) throw new Error("Browser layer assets unavailable");
        const data = await response.json() as AssetResponse;
        if (cancelled) return;
        if (!data.supported) {
          setFallback(snapshot);
          return;
        }
        if (data.source_identity !== sourceIdentity) {
          setInvalid(snapshot);
          return;
        }
        created = await decode(data, layers, sourceWidth, sourceHeight, sourceIdentity);
        if (cancelled) { created.dispose(); return; }
        const asset = created;
        setReady({ ...snapshot, renderer: {
          async render(states) {
            if (cancelled) throw new Error("Discarded source snapshot");
            await verifySource();
            if (cancelled) throw new Error("Discarded source snapshot");
            return asset.render(states);
          },
        } });
      } catch {
        if (cancelled) return;
        // A failed extraction may mean the source changed during preparation.
        try { await verifySource(); } catch { return; }
        if (!cancelled) setFallback(snapshot);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      created?.dispose();
    };
  }, [path, fingerprint, sourceIdentity, sourceWidth, sourceHeight, layers, verifySource]);

  const current: Snapshot | null = layers
    ? { path, fingerprint, sourceIdentity, layers } : null;
  const sourceChanged = Boolean(current && invalid && matches(current, invalid));
  const selectedReady = current && ready && matches(current, ready) ? ready : null;
  const selectedFallback = Boolean(current && fallback && matches(current, fallback));
  // Do not issue a Python fallback while extraction is still in flight.
  const loading = Boolean(sourceIdentity && current && !sourceChanged
    && !selectedReady && !selectedFallback);
  return {
    renderer: !sourceChanged ? selectedReady?.renderer ?? null : null,
    sourceChanged, loading, verifySource,
  };
}
