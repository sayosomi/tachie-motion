/** Only display metadata. Never apply these coordinates to PSD or MOV renders. */
export type ThumbnailView = {
  zoom: number;
  centerX: number;
  centerY: number;
};

export const DEFAULT_THUMBNAIL: Readonly<ThumbnailView> = {
  zoom: 1, centerX: 0.5, centerY: 0.5,
};

export function validThumbnailView(value: unknown): value is ThumbnailView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 3 &&
    Object.hasOwn(fields, "zoom") && Object.hasOwn(fields, "centerX") &&
    Object.hasOwn(fields, "centerY") &&
    typeof fields.zoom === "number" && Number.isFinite(fields.zoom) &&
    fields.zoom >= 1 && fields.zoom <= 8 &&
    typeof fields.centerX === "number" && Number.isFinite(fields.centerX) &&
    fields.centerX >= 0 && fields.centerX <= 1 &&
    typeof fields.centerY === "number" && Number.isFinite(fields.centerY) &&
    fields.centerY >= 0 && fields.centerY <= 1;
}

export function thumbnailView(value?: ThumbnailView): Readonly<ThumbnailView> {
  return value ?? DEFAULT_THUMBNAIL;
}

export function thumbnailLayout(
  view: ThumbnailView, stageWidth: number, stageHeight: number,
  imageWidth: number, imageHeight: number,
): { left: number; top: number; width: number; height: number } | null {
  if (!validThumbnailView(view) ||
      ![stageWidth, stageHeight, imageWidth, imageHeight].every(
        (n) => Number.isFinite(n) && n > 0,
      )) return null;
  const fit = Math.min(stageWidth / imageWidth, stageHeight / imageHeight);
  const width = imageWidth * fit * view.zoom;
  const height = imageHeight * fit * view.zoom;
  const requestedLeft = stageWidth / 2 - width * view.centerX;
  const requestedTop = stageHeight / 2 - height * view.centerY;
  // Retain letterboxing for axes that fit; never expose extra empty space
  // when a zoomed image is larger than the viewport.
  const left = width <= stageWidth ? (stageWidth - width) / 2 :
    Math.max(stageWidth - width, Math.min(0, requestedLeft));
  const top = height <= stageHeight ? (stageHeight - height) / 2 :
    Math.max(stageHeight - height, Math.min(0, requestedTop));
  return { left, top, width, height };
}
