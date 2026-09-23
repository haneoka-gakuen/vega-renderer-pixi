/**
 * WebGAL / MyGO container placement, expressed without a graphics dependency.
 * Positions below are sprite centres in the reference canvas, before authored
 * transforms. Static figures always use M_2_4, regardless of the Live2D mode.
 */
export type WebGalPositioning = "M_2_3" | "M_2_4" | "M_3_0_0" | "M_3_1_0";
export interface WebGalLayoutOptions {
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly width: number;
  readonly height: number;
  readonly position: "left" | "center" | "right" | "bg";
  readonly live2d?: boolean;
  readonly positioning?: WebGalPositioning;
  readonly aggregate?: boolean;
}

export function computeWebGalLayout(options: WebGalLayoutOptions) {
  const { stageWidth, stageHeight, width, height, position } = options;
  for (const value of [stageWidth, stageHeight, width, height]) {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError("WebGAL layout dimensions must be positive and finite");
  }
  let mode = options.live2d ? (options.positioning ?? "M_3_1_0") : "M_2_4";
  if (options.aggregate && mode === "M_3_0_0") mode = "M_2_4";
  let scale =
    position === "bg"
      ? Math.max(stageWidth / width, stageHeight / height)
      : Math.min(stageWidth / width, stageHeight / height);
  if (position !== "bg") {
    if (mode === "M_2_3") scale *= 1.5;
    if (mode === "M_3_0_0" || mode === "M_3_1_0") scale *= 1.25;
  }
  const fittedWidth = width * scale;
  const fittedHeight = height * scale;
  const modern = mode === "M_3_0_0" || mode === "M_3_1_0";
  const legacy = mode === "M_2_3";
  let x = stageWidth / 2;
  if (position !== "bg" && position !== "center") {
    x =
      position === "left"
        ? modern
          ? stageWidth / 2 - 430
          : fittedWidth / 2
        : modern
          ? stageWidth / 2 + 430
          : stageWidth - fittedWidth / 2;
    if (legacy) x += stageWidth / 2;
  }
  const y = legacy
    ? stageHeight / 1.2
    : (position === "bg" ? 0 : Math.max(0, (stageHeight - fittedHeight) / 2)) +
      (modern ? stageHeight / 1.8 : stageHeight / 2);
  return { x, y, scale, width: fittedWidth, height: fittedHeight };
}
