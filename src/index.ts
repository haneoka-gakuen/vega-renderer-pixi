import {
  GenericStoryScene,
  defineVegaPlugin,
  type StorySceneBackendContext,
  type StoryScenePreviewOptions,
  type VegaPlugin,
} from "@haneoka/vega";
import {
  Application,
  BaseTexture,
  Container,
  Graphics,
  ParticleContainer,
  Sprite,
  Texture,
  filters,
} from "pixi.js";

const { BlurFilter, ColorMatrixFilter } = filters;

export interface PixiRendererOptions {
  readonly backend?: string;
  readonly contributionId?: string;
  readonly referenceWidth?: number;
  readonly referenceHeight?: number;
  readonly backgroundColor?: number;
  readonly antialias?: boolean;
  readonly autoDensity?: boolean;
  readonly maxResolution?: number;
  readonly profile?: "vega" | "webgal";
}

export interface PixiViewport {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface PixiStageInspection {
  readonly renderer: "pixi";
  readonly profile: "vega" | "webgal";
  readonly referenceSize: readonly [number, number];
  readonly viewport: PixiViewport;
  readonly characters: readonly string[];
  readonly background: boolean;
  readonly still: boolean;
  readonly effects: readonly string[];
}

export type PixiAmbientEffect = "rain" | "snow" | "petals";

export interface PixiAmbientEffectOptions {
  readonly count?: number;
  readonly speed?: number;
  readonly alpha?: number;
  readonly color?: number;
  readonly seed?: number;
}

interface PixiLease {
  readonly sprite: Sprite;
  readonly release: () => void;
}

interface PixiCharacter {
  readonly target: string;
  readonly sprite: Sprite;
  readonly lease: () => void;
  positionType: number;
  brightness: number;
  blur: number;
  offsetX: number;
  offsetY: number;
  worldPosition: { x: number; y: number } | null;
}

interface PixiEffectInstance {
  readonly container: Container;
  readonly tick: (delta: number) => void;
  readonly texture: Texture;
}

interface PixiTextureRecord {
  readonly texture: Texture;
  readonly ready: Promise<void>;
  references: number;
  disposed: boolean;
}

interface PixiAnimation {
  readonly cancel: () => void;
}

const finite = (value: unknown, fallback = 0): number => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};

const positive = (value: unknown, fallback: number): number => {
  const result = finite(value, fallback);
  return result > 0 ? result : fallback;
};

const clamp = (value: unknown, minimum = 0, maximum = 1): number =>
  Math.max(minimum, Math.min(maximum, finite(value, minimum)));

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const firstString = (...values: unknown[]): string =>
  values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean) ?? "";

const looksLikeImage = (source: string): boolean =>
  /^(?:blob:|data:image\/)/iu.test(source) ||
  /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu.test(source);

export const pixiStaticCharacterSource = (entry: unknown): string => {
  const source = object(entry);
  const runtime = object(source.runtime);
  const model = firstString(
    runtime.model,
    runtime.modelUrl,
    source.model,
    source.modelUrl,
  );
  const explicit = firstString(
    runtime.imageUrl,
    source.imageUrl,
    source.portraitUrl,
    runtime.source,
    source.source,
  );
  if (explicit) return explicit;
  return looksLikeImage(model) ? model : "";
};

const backgroundSource = (entry: unknown): string => {
  const source = object(entry);
  return firstString(
    source.playableUrl,
    source.imageUrl,
    source.url,
    source.source,
  );
};

export const computePixiViewport = (
  width: number,
  height: number,
  referenceWidth = 1920,
  referenceHeight = 1080,
): PixiViewport => {
  const safeWidth = positive(width, 1);
  const safeHeight = positive(height, 1);
  const safeReferenceWidth = positive(referenceWidth, 1920);
  const safeReferenceHeight = positive(referenceHeight, 1080);
  const scale = Math.min(
    safeWidth / safeReferenceWidth,
    safeHeight / safeReferenceHeight,
  );
  const normalizeOffset = (value: number): number =>
    Math.abs(value) < Number.EPSILON * 512 ? 0 : value;
  return {
    width: safeWidth,
    height: safeHeight,
    scale,
    offsetX: normalizeOffset((safeWidth - safeReferenceWidth * scale) / 2),
    offsetY: normalizeOffset((safeHeight - safeReferenceHeight * scale) / 2),
  };
};

const tintFromBrightness = (brightness: number): number => {
  const channel = Math.round(clamp(brightness) * 255);
  return (channel << 16) | (channel << 8) | channel;
};

const waitForTexture = (texture: Texture): Promise<void> => {
  if (texture.baseTexture.valid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const loaded = () => {
      cleanup();
      resolve();
    };
    const failed = (error: unknown) => {
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new Error("Pixi texture failed to load"),
      );
    };
    const cleanup = () => {
      texture.baseTexture.off("loaded", loaded);
      texture.baseTexture.off("error", failed);
    };
    texture.baseTexture.once("loaded", loaded);
    texture.baseTexture.once("error", failed);
  });
};

const abortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The Pixi resource request was aborted");
  error.name = "AbortError";
  return error;
};

const withAbort = async <T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  if (signal.aborted) throw abortReason(signal);
  let aborted: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    if (aborted) signal.removeEventListener("abort", aborted);
  }
};

const linkSignals = (
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; readonly release: () => void } => {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      break;
    }
    const abort = () => controller.abort(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    listeners.push([signal, abort]);
  }
  return {
    signal: controller.signal,
    release: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
};

/**
 * Pixi owns stage pixels; GenericStoryScene remains the command-complete
 * fallback for DOM UI, video, rule transitions, saves and unsupported assets.
 */
export class PixiStoryScene extends GenericStoryScene {
  readonly backend: string;
  readonly profile: "vega" | "webgal";
  private readonly context: StorySceneBackendContext;
  private readonly options: Required<
    Pick<
      PixiRendererOptions,
      | "referenceWidth"
      | "referenceHeight"
      | "backgroundColor"
      | "antialias"
      | "autoDensity"
      | "maxResolution"
      | "profile"
    >
  >;
  private app: Application | null = null;
  private pixiRoot: HTMLElement | null = null;
  private readonly viewportWorld = new Container();
  private readonly world = new Container();
  private readonly pixiBackgroundLayer = new Container();
  private readonly pixiCharacterLayer = new Container();
  private readonly pixiStillLayer = new Container();
  private readonly pixiEffectLayer = new Container();
  private pixiBackgroundLease: PixiLease | null = null;
  private pixiStillLease: PixiLease | null = null;
  private readonly pixiCharacters = new Map<string, PixiCharacter>();
  private readonly pixiEffects = new Map<
    PixiAmbientEffect,
    PixiEffectInstance
  >();
  private readonly texturePool = new Map<string, PixiTextureRecord>();
  private viewport: PixiViewport = computePixiViewport(1, 1);
  private observer: ResizeObserver | null = null;
  private readonly lifecycleController = new AbortController();
  private backgroundGeneration = 0;
  private stillGeneration = 0;
  private readonly characterGenerations = new Map<string, number>();
  private readonly animations = new Map<string, PixiAnimation>();
  private colorMatrixFilter: InstanceType<typeof ColorMatrixFilter> | null =
    null;
  private pixiBackgroundBrightness = 1;
  private pixiBackgroundBlur = 0;
  private pixiDeterministicReplay = false;
  private pixiDestroyed = false;

  constructor(
    context: StorySceneBackendContext,
    options: PixiRendererOptions = {},
  ) {
    super(context.runtime, context.state, context.resources, {
      ...(context.characterProviders
        ? { characterProviders: context.characterProviders }
        : {}),
    });
    this.context = context;
    this.backend = options.backend || "pixi";
    this.profile = options.profile || "vega";
    this.options = {
      referenceWidth: positive(options.referenceWidth, 1920),
      referenceHeight: positive(options.referenceHeight, 1080),
      backgroundColor: Math.trunc(finite(options.backgroundColor, 0x050713)),
      antialias: options.antialias ?? true,
      autoDensity: options.autoDensity ?? true,
      maxResolution: positive(options.maxResolution, 2),
      profile: this.profile,
    };
    this.viewportWorld.addChild(this.world);
    this.world.sortableChildren = true;
    this.pixiBackgroundLayer.zIndex = 0;
    this.pixiCharacterLayer.zIndex = 10;
    this.pixiStillLayer.zIndex = 20;
    this.pixiEffectLayer.zIndex = 30;
    this.world.addChild(
      this.pixiBackgroundLayer,
      this.pixiCharacterLayer,
      this.pixiStillLayer,
      this.pixiEffectLayer,
    );
  }

  override async setup(mount: HTMLElement): Promise<void> {
    if (this.pixiDestroyed || this.context.signal.aborted) {
      throw abortReason(this.context.signal);
    }
    await super.setup(mount);
    if (this.app) return;
    const roots = mount.querySelectorAll<HTMLElement>(
      '[data-vega-scene="generic"]',
    );
    const root = roots.item(roots.length - 1);
    if (!root)
      throw new Error("Vega Pixi renderer could not find its stage root");
    const resolution = Math.min(
      this.options.maxResolution,
      Math.max(1, finite(globalThis.devicePixelRatio, 1)),
    );
    const app = new Application({
      width: Math.max(1, root.clientWidth),
      height: Math.max(1, root.clientHeight),
      backgroundColor: this.options.backgroundColor,
      antialias: this.options.antialias,
      autoDensity: this.options.autoDensity,
      resolution,
      powerPreference: "high-performance",
      sharedTicker: false,
    });
    const canvas = app.view as HTMLCanvasElement;
    canvas.className = "vega-stage__pixi";
    canvas.dataset.vegaRenderer = "pixi";
    canvas.style.cssText =
      "position:absolute;inset:0;z-index:0;width:100%;height:100%;display:block;";
    root.prepend(canvas);
    root.dataset.vegaScene = "pixi";
    root.dataset.vegaPixiProfile = this.profile;
    app.stage.addChild(this.viewportWorld);
    this.pixiRoot = root;
    this.app = app;
    this.resize();
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(root);
    }
  }

  override async destroy(_options?: {
    releaseTextures?: boolean;
  }): Promise<void> {
    if (this.pixiDestroyed) return;
    this.pixiDestroyed = true;
    this.lifecycleController.abort();
    this.backgroundGeneration += 1;
    this.stillGeneration += 1;
    for (const target of this.characterGenerations.keys()) {
      this.characterGenerations.set(
        target,
        (this.characterGenerations.get(target) ?? 0) + 1,
      );
    }
    this.observer?.disconnect();
    this.observer = null;
    this.cancelAllAnimations();
    this.releasePixiLease(this.pixiBackgroundLease);
    this.releasePixiLease(this.pixiStillLease);
    this.pixiBackgroundLease = null;
    this.pixiStillLease = null;
    for (const character of this.pixiCharacters.values()) {
      this.releasePixiCharacter(character);
    }
    this.pixiCharacters.clear();
    for (const effect of this.pixiEffects.values()) {
      this.app?.ticker.remove(effect.tick);
      effect.container.destroy({
        children: true,
        texture: false,
        baseTexture: false,
      });
      effect.texture.destroy(true);
    }
    this.pixiEffects.clear();
    this.clearColorMatrix();
    if (this.app) {
      this.app.destroy(true, {
        children: true,
        texture: false,
        baseTexture: false,
      });
    }
    for (const record of this.texturePool.values()) {
      if (record.references === 0) this.disposeTextureRecord(record);
    }
    this.texturePool.clear();
    this.app = null;
    this.pixiRoot = null;
    await super.destroy();
  }

  override resize(): void {
    super.resize();
    const root = this.pixiRoot;
    const app = this.app;
    if (!root || !app) return;
    const width = Math.max(1, root.clientWidth);
    const height = Math.max(1, root.clientHeight);
    app.renderer.resize(width, height);
    this.viewport = computePixiViewport(
      width,
      height,
      this.options.referenceWidth,
      this.options.referenceHeight,
    );
    this.viewportWorld.position.set(
      this.viewport.offsetX,
      this.viewport.offsetY,
    );
    this.viewportWorld.scale.set(this.viewport.scale);
    this.fitLease(this.pixiBackgroundLease, "cover");
    this.fitLease(this.pixiStillLease, "contain");
    for (const character of this.pixiCharacters.values()) {
      this.layoutCharacter(character);
    }
  }

  capturePreview(
    options: StoryScenePreviewOptions,
  ): string | undefined {
    const app = this.app;
    const document = this.pixiRoot?.ownerDocument;
    if (!app || !document?.createElement) return undefined;
    try {
      const source = app.renderer.plugins.extract.canvas(app.stage);
      if (!source.width || !source.height) return undefined;
      const preview = document.createElement("canvas");
      preview.width = Math.max(1, Math.round(options.width));
      preview.height = Math.max(1, Math.round(options.height));
      const context = preview.getContext("2d");
      if (!context) return undefined;
      const scale = Math.max(
        preview.width / source.width,
        preview.height / source.height,
      );
      const width = source.width * scale;
      const height = source.height * scale;
      context.drawImage(
        source,
        (preview.width - width) / 2,
        (preview.height - height) / 2,
        width,
        height,
      );
      return preview.toDataURL(options.format, options.quality);
    } catch {
      // Extraction can fail for tainted cross-origin textures. Saving gameplay
      // state must remain available even when an optional preview cannot.
      return undefined;
    }
  }

  override setDeterministicReplayActive(active: boolean): void {
    super.setDeterministicReplayActive(active);
    this.pixiDeterministicReplay = Boolean(active);
  }

  override async setBackground(
    ...args: Parameters<GenericStoryScene["setBackground"]>
  ): Promise<boolean> {
    const generation = ++this.backgroundGeneration;
    const result = await super.setBackground(...args);
    if (generation !== this.backgroundGeneration || this.pixiDestroyed) {
      return result;
    }
    const [entry] = args;
    const source = backgroundSource(entry);
    if (!source || !this.app) {
      this.releasePixiLease(this.pixiBackgroundLease);
      this.pixiBackgroundLease = null;
      this.showDomLayer("background");
      return result;
    }
    const lease = await this.createSpriteLease(
      source,
      args[3] ?? this.context.signal,
    );
    if (generation !== this.backgroundGeneration || this.pixiDestroyed) {
      this.releasePixiLease(lease);
      return result;
    }
    lease.sprite.anchor.set(0.5);
    this.pixiBackgroundLayer.addChild(lease.sprite);
    this.releasePixiLease(this.pixiBackgroundLease);
    this.pixiBackgroundLease = lease;
    lease.sprite.tint = tintFromBrightness(this.pixiBackgroundBrightness);
    this.setBlur(lease.sprite, this.pixiBackgroundBlur);
    this.fitLease(lease, "cover");
    this.hideDomLayer("background");
    return result;
  }

  override async setStill(
    ...args: Parameters<GenericStoryScene["setStill"]>
  ): Promise<void> {
    const generation = ++this.stillGeneration;
    await super.setStill(...args);
    if (generation !== this.stillGeneration || this.pixiDestroyed) return;
    const [entry, alpha = 1] = args;
    const source = backgroundSource(entry);
    if (!source || !this.app) {
      this.releasePixiLease(this.pixiStillLease);
      this.pixiStillLease = null;
      this.showDomLayer("still");
      return;
    }
    const lease = await this.createSpriteLease(source, this.context.signal);
    if (generation !== this.stillGeneration || this.pixiDestroyed) {
      this.releasePixiLease(lease);
      return;
    }
    lease.sprite.anchor.set(0.5);
    lease.sprite.alpha = clamp(alpha);
    this.pixiStillLayer.addChild(lease.sprite);
    this.releasePixiLease(this.pixiStillLease);
    this.pixiStillLease = lease;
    this.fitLease(lease, "contain");
    this.hideDomLayer("still");
  }

  override async clearStill(
    ...args: Parameters<GenericStoryScene["clearStill"]>
  ): Promise<void> {
    const generation = ++this.stillGeneration;
    await super.clearStill(...args);
    if (generation !== this.stillGeneration || this.pixiDestroyed) return;
    this.releasePixiLease(this.pixiStillLease);
    this.pixiStillLease = null;
    this.showDomLayer("still");
  }

  override async fadeStill(
    ...args: Parameters<GenericStoryScene["fadeStill"]>
  ): Promise<void> {
    const lease = this.pixiStillLease;
    const animation = lease
      ? this.animateNumber(
          "still:alpha",
          lease.sprite.alpha,
          clamp(args[0]),
          finite(args[1]),
          (value) => {
            if (this.pixiStillLease === lease) lease.sprite.alpha = value;
          },
        )
      : Promise.resolve();
    await Promise.all([super.fadeStill(...args), animation]);
  }

  override async placeCharacter(
    ...args: Parameters<GenericStoryScene["placeCharacter"]>
  ): Promise<void> {
    const [command, positionType] = args;
    const target = firstString(
      command.targetName,
      command.targets?.[0]?.target,
      command.characterKey,
    );
    const generation = target
      ? (this.characterGenerations.get(target) ?? 0) + 1
      : 0;
    if (target) this.characterGenerations.set(target, generation);
    await super.placeCharacter(...args);
    if (
      !target ||
      generation !== this.characterGenerations.get(target) ||
      this.pixiDestroyed
    ) {
      return;
    }
    const previous = this.pixiCharacters.get(target);
    if (previous) {
      this.cancelAnimations(`character:${target}:`);
      this.releasePixiCharacter(previous);
      this.pixiCharacters.delete(target);
    }
    const host = this.domCharacter(target);
    const source =
      host?.dataset.vegaCharacterProvider === "vega.static-portrait"
        ? pixiStaticCharacterSource(command.characterModel)
        : "";
    if (!source || !this.app) {
      this.showDomCharacter(target);
      return;
    }
    const lease = await this.createSpriteLease(source, this.context.signal);
    if (
      generation !== this.characterGenerations.get(target) ||
      this.pixiDestroyed
    ) {
      this.releasePixiLease(lease);
      return;
    }
    lease.sprite.anchor.set(0.5, 1);
    const presentation = object(command.characterPresentation);
    const character: PixiCharacter = {
      target,
      sprite: lease.sprite,
      lease: lease.release,
      positionType,
      brightness: clamp(presentation.brightness ?? 1),
      blur: clamp(presentation.blurIntensity),
      offsetX: 0,
      offsetY: 0,
      worldPosition: command.characterWorldPosition
        ? {
            x: finite(command.characterWorldPosition.x),
            y: finite(command.characterWorldPosition.y),
          }
        : null,
    };
    character.sprite.alpha = clamp(presentation.alpha ?? 1);
    character.sprite.angle = finite(presentation.angle);
    character.sprite.tint = tintFromBrightness(character.brightness);
    this.setBlur(character.sprite, character.blur);
    this.pixiCharacters.set(target, character);
    this.pixiCharacterLayer.addChild(character.sprite);
    this.layoutCharacter(character);
    this.hideDomCharacter(target);
  }

  override async removeCharacter(
    ...args: Parameters<GenericStoryScene["removeCharacter"]>
  ): Promise<boolean> {
    const target = args[0];
    this.characterGenerations.set(
      target,
      (this.characterGenerations.get(target) ?? 0) + 1,
    );
    const character = this.pixiCharacters.get(target);
    const animation = character
      ? this.animateNumber(
          `character:${target}:alpha`,
          character.sprite.alpha,
          0,
          finite(args[1]),
          (value) => {
            if (this.pixiCharacters.get(target) === character) {
              character.sprite.alpha = value;
            }
          },
        )
      : Promise.resolve();
    const [result] = await Promise.all([
      super.removeCharacter(...args),
      animation,
    ]);
    if (character) {
      this.cancelAnimations(`character:${target}:`);
      this.releasePixiCharacter(character);
      this.pixiCharacters.delete(target);
    }
    this.showDomCharacter(target);
    return result;
  }

  override async fadeCharacter(
    ...args: Parameters<GenericStoryScene["fadeCharacter"]>
  ): Promise<void> {
    const character = this.pixiCharacters.get(args[0]);
    const animation = character
      ? this.animateNumber(
          `character:${args[0]}:alpha`,
          character.sprite.alpha,
          clamp(args[1]),
          finite(args[2]),
          (value) => {
            if (this.pixiCharacters.get(args[0]) === character) {
              character.sprite.alpha = value;
            }
          },
        )
      : Promise.resolve();
    await Promise.all([super.fadeCharacter(...args), animation]);
  }

  override async moveCharacter(
    ...args: Parameters<GenericStoryScene["moveCharacter"]>
  ): Promise<void> {
    await super.moveCharacter(...args);
    const [positionType, offset] = args;
    for (const character of this.pixiCharacters.values()) {
      if (character.positionType !== positionType) continue;
      character.worldPosition = null;
      character.offsetX += finite(offset.x);
      character.offsetY += finite(offset.y);
      this.layoutCharacter(character);
    }
  }

  override async moveCharacterToWorld(
    ...args: Parameters<GenericStoryScene["moveCharacterToWorld"]>
  ): Promise<void> {
    await super.moveCharacterToWorld(...args);
    const [target, destination, positionType] = args;
    const character = this.pixiCharacters.get(target);
    if (!character) return;
    if (positionType) character.positionType = positionType;
    character.worldPosition = {
      x: finite(destination.x),
      y: finite(destination.y),
    };
    this.layoutCharacter(character);
  }

  override async setCharacterAngle(
    ...args: Parameters<GenericStoryScene["setCharacterAngle"]>
  ): Promise<void> {
    const character = this.pixiCharacters.get(args[0]);
    const destination = finite(args[1]) + finite(args[2]);
    const animation = character
      ? this.animateNumber(
          `character:${args[0]}:angle`,
          character.sprite.angle,
          destination,
          finite(args[3]),
          (value) => {
            if (this.pixiCharacters.get(args[0]) === character) {
              character.sprite.angle = value;
            }
          },
        )
      : Promise.resolve();
    await Promise.all([super.setCharacterAngle(...args), animation]);
  }

  override async setBrightness(
    ...args: Parameters<GenericStoryScene["setBrightness"]>
  ): Promise<void> {
    const character = this.pixiCharacters.get(args[0]);
    const destination = clamp(args[1]);
    const animation = character
      ? this.animateNumber(
          `character:${args[0]}:brightness`,
          character.brightness,
          destination,
          finite(args[2]),
          (value) => {
            if (this.pixiCharacters.get(args[0]) !== character) return;
            character.brightness = value;
            character.sprite.tint = tintFromBrightness(value);
          },
        )
      : Promise.resolve();
    await Promise.all([super.setBrightness(...args), animation]);
  }

  override async setCharacterDoF(
    ...args: Parameters<GenericStoryScene["setCharacterDoF"]>
  ): Promise<void> {
    const character = this.pixiCharacters.get(args[0]);
    const destination = clamp(args[1]);
    const animation = character
      ? this.animateNumber(
          `character:${args[0]}:blur`,
          character.blur,
          destination,
          finite(args[2]),
          (value) => {
            if (this.pixiCharacters.get(args[0]) !== character) return;
            character.blur = value;
            this.setBlur(character.sprite, value);
          },
        )
      : Promise.resolve();
    await Promise.all([super.setCharacterDoF(...args), animation]);
  }

  override async setBackgroundDoF(
    ...args: Parameters<GenericStoryScene["setBackgroundDoF"]>
  ): Promise<void> {
    const lease = this.pixiBackgroundLease;
    const destination = clamp(args[0]);
    const animation = this.animateNumber(
      "background:blur",
      this.pixiBackgroundBlur,
      destination,
      finite(args[1]),
      (value) => {
        this.pixiBackgroundBlur = value;
        if (this.pixiBackgroundLease === lease && lease) {
          this.setBlur(lease.sprite, value);
        }
      },
    );
    await Promise.all([super.setBackgroundDoF(...args), animation]);
  }

  override async setBackgroundBrightness(
    ...args: Parameters<GenericStoryScene["setBackgroundBrightness"]>
  ): Promise<void> {
    const lease = this.pixiBackgroundLease;
    const destination = clamp(args[0]);
    const animation = this.animateNumber(
      "background:brightness",
      this.pixiBackgroundBrightness,
      destination,
      finite(args[1]),
      (value) => {
        this.pixiBackgroundBrightness = value;
        if (this.pixiBackgroundLease === lease && lease) {
          lease.sprite.tint = tintFromBrightness(value);
        }
      },
    );
    await Promise.all([super.setBackgroundBrightness(...args), animation]);
  }

  inspect(): PixiStageInspection {
    return Object.freeze({
      renderer: "pixi",
      profile: this.profile,
      referenceSize: [
        this.options.referenceWidth,
        this.options.referenceHeight,
      ] as const,
      viewport: { ...this.viewport },
      characters: [...this.pixiCharacters.keys()].sort(),
      background: Boolean(this.pixiBackgroundLease),
      still: Boolean(this.pixiStillLease),
      effects: [...this.pixiEffects.keys()].sort(),
    });
  }

  setWorldTransform(transform: {
    readonly x?: number;
    readonly y?: number;
    readonly scale?: number;
    readonly rotationDegrees?: number;
  }): void {
    const scale = positive(transform.scale, 1);
    this.world.pivot.set(
      this.options.referenceWidth / 2,
      this.options.referenceHeight / 2,
    );
    this.world.position.set(
      this.options.referenceWidth * 0.5 + finite(transform.x),
      this.options.referenceHeight * 0.5 + finite(transform.y),
    );
    this.world.scale.set(scale);
    this.world.rotation = (finite(transform.rotationDegrees) * Math.PI) / 180;
  }

  setAmbientEffect(
    effect: PixiAmbientEffect,
    options: PixiAmbientEffectOptions = {},
  ): void {
    this.clearAmbientEffect(effect);
    if (!this.app) return;
    const count = Math.max(
      1,
      Math.min(
        512,
        Math.trunc(finite(options.count, effect === "rain" ? 120 : 72)),
      ),
    );
    const speed = positive(
      options.speed,
      effect === "rain" ? 24 : effect === "snow" ? 3.2 : 2.4,
    );
    const alpha =
      options.alpha === undefined ? 0.72 : clamp(options.alpha, 0, 1);
    const color =
      Math.trunc(
        finite(options.color, effect === "petals" ? 0xffb7cc : 0xffffff),
      ) & 0xffffff;
    let seed = Math.trunc(finite(options.seed, 0x51a7e)) >>> 0;
    const random = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), seed | 1) + 0x6d2b79f5) >>> 0;
      return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296;
    };
    const container = new Container();
    container.name = `vega-pixi-effect:${effect}`;
    const glyph = new Graphics();
    glyph.beginFill(0xffffff);
    if (effect === "rain") {
      glyph.drawRoundedRect(-1, -12, 2, 24, 1);
    } else if (effect === "snow") {
      glyph.drawCircle(0, 0, 4);
    } else {
      glyph.drawEllipse(0, 0, 5, 3);
    }
    glyph.endFill();
    const texture = this.app.renderer.generateTexture(glyph, {
      resolution: 1,
    });
    glyph.destroy();
    const particleContainer = new ParticleContainer(
      count,
      {
        position: true,
        rotation: true,
        vertices: true,
        tint: true,
      },
      Math.min(count, 512),
    );
    container.addChild(particleContainer);
    const particles: Array<{
      readonly sprite: Sprite;
      readonly velocityX: number;
      readonly velocityY: number;
      readonly spin: number;
    }> = [];
    for (let index = 0; index < count; index += 1) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.tint = color;
      sprite.alpha = alpha * (0.5 + random() * 0.5);
      sprite.scale.set(
        effect === "rain" ? 0.7 + random() * 0.8 : 0.45 + random() * 0.9,
      );
      sprite.position.set(
        random() * this.options.referenceWidth,
        random() * this.options.referenceHeight,
      );
      sprite.rotation = random() * Math.PI * 2;
      particleContainer.addChild(sprite);
      particles.push({
        sprite,
        velocityX: effect === "rain" ? -speed * 0.18 : (random() - 0.5) * speed,
        velocityY: effect === "rain" ? speed : speed * (0.55 + random() * 0.8),
        spin: (random() - 0.5) * 0.04,
      });
    }
    const tick = (delta: number) => {
      for (const particle of particles) {
        particle.sprite.x += particle.velocityX * delta;
        particle.sprite.y += particle.velocityY * delta;
        particle.sprite.rotation += particle.spin * delta;
        if (particle.sprite.y > this.options.referenceHeight + 32) {
          particle.sprite.y = -32;
          particle.sprite.x = random() * this.options.referenceWidth;
        }
        if (particle.sprite.x < -32) {
          particle.sprite.x = this.options.referenceWidth + 32;
        }
        if (particle.sprite.x > this.options.referenceWidth + 32) {
          particle.sprite.x = -32;
        }
      }
    };
    this.pixiEffects.set(effect, { container, tick, texture });
    this.pixiEffectLayer.addChild(container);
    this.app.ticker.add(tick);
  }

  clearAmbientEffect(effect?: PixiAmbientEffect): void {
    const targets = effect ? [effect] : [...this.pixiEffects.keys()];
    for (const target of targets) {
      const instance = this.pixiEffects.get(target);
      if (!instance) continue;
      this.app?.ticker.remove(instance.tick);
      instance.container.destroy({
        children: true,
        texture: false,
        baseTexture: false,
      });
      instance.texture.destroy(true);
      this.pixiEffects.delete(target);
    }
  }

  applyColorMatrix(values: readonly number[]): void {
    if (
      values.length !== 20 ||
      values.some((value) => !Number.isFinite(value))
    ) {
      throw new TypeError("A Pixi color matrix must contain 20 finite values");
    }
    const filter = this.colorMatrixFilter ?? new ColorMatrixFilter();
    this.colorMatrixFilter = filter;
    filter.matrix = [...values] as unknown as typeof filter.matrix;
    if (!(this.world.filters ?? []).includes(filter)) {
      this.world.filters = [...(this.world.filters ?? []), filter];
    }
  }

  clearColorMatrix(): void {
    const filter = this.colorMatrixFilter;
    if (!filter) return;
    this.world.filters = (this.world.filters ?? []).filter(
      (candidate) => candidate !== filter,
    );
    filter.destroy();
    this.colorMatrixFilter = null;
  }

  private animateNumber(
    key: string,
    from: number,
    to: number,
    durationSeconds: number,
    update: (value: number) => void,
  ): Promise<void> {
    this.animations.get(key)?.cancel();
    const app = this.app;
    const duration = Math.max(0, finite(durationSeconds));
    if (!app || this.pixiDeterministicReplay || duration === 0) {
      update(to);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let elapsed = 0;
      let settled = false;
      let animation: PixiAnimation;
      const finish = (complete: boolean) => {
        if (settled) return;
        settled = true;
        app.ticker.remove(tick);
        this.lifecycleController.signal.removeEventListener("abort", cancel);
        this.context.signal.removeEventListener("abort", cancel);
        if (this.animations.get(key) === animation) {
          this.animations.delete(key);
        }
        if (complete) update(to);
        resolve();
      };
      const cancel = () => finish(false);
      const tick = (delta: number) => {
        elapsed += Math.max(0, finite(delta)) / 60;
        const ratio = clamp(elapsed / duration);
        update(from + (to - from) * ratio);
        if (ratio >= 1) finish(true);
      };
      animation = { cancel };
      this.animations.set(key, animation);
      this.lifecycleController.signal.addEventListener("abort", cancel, {
        once: true,
      });
      this.context.signal.addEventListener("abort", cancel, { once: true });
      app.ticker.add(tick);
    });
  }

  private cancelAnimations(prefix: string): void {
    for (const [key, animation] of [...this.animations]) {
      if (key.startsWith(prefix)) animation.cancel();
    }
  }

  private cancelAllAnimations(): void {
    for (const animation of [...this.animations.values()]) {
      animation.cancel();
    }
  }

  private async createSpriteLease(
    source: string,
    externalSignal?: AbortSignal,
  ): Promise<PixiLease> {
    const linked = linkSignals([
      this.context.signal,
      this.lifecycleController.signal,
      externalSignal,
    ]);
    let renderable:
      { readonly url: string; readonly release: () => void } | undefined;
    let record: PixiTextureRecord | undefined;
    try {
      renderable = await this.context.resources.resolveRenderable(
        source,
        linked.signal,
      );
      if (linked.signal.aborted) throw abortReason(linked.signal);
      record = this.acquireTextureRecord(renderable.url);
      await withAbort(record.ready, linked.signal);
      if (linked.signal.aborted) throw abortReason(linked.signal);
      const sprite = new Sprite(record.texture);
      let released = false;
      return {
        sprite,
        release: () => {
          if (released) return;
          released = true;
          try {
            renderable?.release();
          } finally {
            this.releaseTextureRecord(record);
          }
        },
      };
    } catch (error) {
      try {
        renderable?.release();
      } finally {
        this.releaseTextureRecord(record);
      }
      throw error;
    } finally {
      linked.release();
    }
  }

  private acquireTextureRecord(url: string): PixiTextureRecord {
    const pooled = this.texturePool.get(url);
    if (pooled && !pooled.disposed) {
      pooled.references += 1;
      return pooled;
    }
    // Construct a private texture instead of borrowing Pixi's process-global
    // URL cache. This scene can then release it without invalidating another
    // Pixi application that happens to use the same URL.
    const texture = new Texture(new BaseTexture(url));
    const record: PixiTextureRecord = {
      texture,
      ready: waitForTexture(texture),
      references: 1,
      disposed: false,
    };
    this.texturePool.set(url, record);
    void record.ready
      .catch(() => undefined)
      .finally(() => {
        if (record.references === 0) this.disposeTextureRecord(record);
      });
    return record;
  }

  private releaseTextureRecord(record?: PixiTextureRecord): void {
    if (!record || record.references <= 0) return;
    record.references -= 1;
    if (record.references !== 0) return;
    void record.ready
      .catch(() => undefined)
      .finally(() => this.disposeTextureRecord(record));
  }

  private disposeTextureRecord(record: PixiTextureRecord): void {
    if (record.references !== 0 || record.disposed) return;
    record.disposed = true;
    for (const [url, candidate] of this.texturePool) {
      if (candidate !== record) continue;
      this.texturePool.delete(url);
    }
    record.texture.destroy(true);
  }

  private fitLease(lease: PixiLease | null, mode: "cover" | "contain"): void {
    if (!lease) return;
    const width = positive(
      lease.sprite.texture.width,
      this.options.referenceWidth,
    );
    const height = positive(
      lease.sprite.texture.height,
      this.options.referenceHeight,
    );
    const scale =
      mode === "cover"
        ? Math.max(
            this.options.referenceWidth / width,
            this.options.referenceHeight / height,
          )
        : Math.min(
            this.options.referenceWidth / width,
            this.options.referenceHeight / height,
          );
    lease.sprite.position.set(
      this.options.referenceWidth / 2,
      this.options.referenceHeight / 2,
    );
    lease.sprite.scale.set(scale);
  }

  private layoutCharacter(character: PixiCharacter): void {
    const point = this.stagePoint(character.positionType);
    const stageWidth = Math.max(
      0.001,
      finite(this.context.runtime.stage.width, 3.2),
    );
    const unitX = (this.options.referenceWidth * 0.84) / stageWidth;
    const unitY = (this.options.referenceHeight * 0.84) / stageWidth;
    const x = character.worldPosition
      ? this.options.referenceWidth / 2 + character.worldPosition.x * unitX
      : this.options.referenceWidth / 2 +
        (point.x /
          Math.max(0.001, finite(this.context.runtime.stage.maxX, 1.6))) *
          (this.options.referenceWidth * 0.42) +
        character.offsetX * unitX;
    const y = character.worldPosition
      ? this.options.referenceHeight - character.worldPosition.y * unitY
      : this.options.referenceHeight - character.offsetY * unitY;
    const sourceHeight = positive(
      character.sprite.texture.height,
      this.options.referenceHeight,
    );
    const scale = (this.options.referenceHeight * 0.94) / sourceHeight;
    character.sprite.position.set(x, y);
    character.sprite.scale.set(scale);
  }

  private hideDomLayer(name: string): void {
    const layer = this.pixiRoot?.querySelector<HTMLElement>(
      `[data-vega-layer="${name}"]`,
    );
    if (layer) layer.style.visibility = "hidden";
  }

  private showDomLayer(name: string): void {
    const layer = this.pixiRoot?.querySelector<HTMLElement>(
      `[data-vega-layer="${name}"]`,
    );
    if (layer) layer.style.removeProperty("visibility");
  }

  private hideDomCharacter(target: string): void {
    const host = this.domCharacter(target);
    if (host) host.style.visibility = "hidden";
  }

  private showDomCharacter(target: string): void {
    const host = this.domCharacter(target);
    if (host) host.style.removeProperty("visibility");
  }

  private domCharacter(target: string): HTMLElement | null {
    const escaped =
      globalThis.CSS?.escape?.(target) ??
      target.replace(/["\\]/gu, (character) => `\\${character}`);
    return (
      this.pixiRoot?.querySelector<HTMLElement>(
        `[data-vega-character="${escaped}"]`,
      ) ?? null
    );
  }

  private setBlur(sprite: Sprite, intensity: number): void {
    const filters = sprite.filters ?? [];
    const existing = filters.find(
      (candidate): candidate is InstanceType<typeof BlurFilter> =>
        candidate instanceof BlurFilter,
    );
    if (intensity <= 0) {
      if (!existing) return;
      sprite.filters = filters.filter((candidate) => candidate !== existing);
      existing.destroy();
      return;
    }
    if (existing) {
      existing.blur = Math.min(32, intensity * 16);
      return;
    }
    const blur = new BlurFilter(Math.min(32, intensity * 16), 4);
    sprite.filters = [...filters, blur];
  }

  private releasePixiLease(lease: PixiLease | null): void {
    if (!lease) return;
    try {
      lease.sprite.destroy({
        children: true,
        texture: false,
        baseTexture: false,
      });
    } finally {
      lease.release();
    }
  }

  private releasePixiCharacter(character: PixiCharacter): void {
    try {
      character.sprite.destroy({
        children: true,
        texture: false,
        baseTexture: false,
      });
    } finally {
      character.lease();
    }
  }
}

export const createPixiRendererPlugin = (
  options: PixiRendererOptions = {},
): VegaPlugin =>
  defineVegaPlugin({
    manifest: {
      id: "haneoka.renderer-pixi",
      name: "Vega Pixi Renderer",
      version: "0.1.0",
      apiVersion: 1,
      description: "GPU-accelerated 2D stage renderer backed by PixiJS",
      capabilities: ["render"],
    },
    setup(context) {
      context.contribute("render", {
        id: options.contributionId || "vega-pixi",
        name: "Vega Pixi",
        backend: options.backend || "pixi",
        create: (sceneContext) => new PixiStoryScene(sceneContext, options),
      });
    },
  });

export default createPixiRendererPlugin;
