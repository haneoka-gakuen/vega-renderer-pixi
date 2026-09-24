import {
  StoryScreenEffects,
  isStoryScreenSpriteEffect,
  type StoryScreenEffectDefinition,
  type StoryScreenEffectSnapshot,
} from "@haneoka/vega/renderer-kit";
import { PixiScreenSpriteRenderer } from "./ScreenSpriteRenderer.js";
import {
  GenericStoryScene,
  storyResourceContentType,
  defineVegaPlugin,
  type StoryResourceResolver,
  type StorySceneBackendContext,
  type StoryScenePreviewOptions,
  type VegaPlugin,
} from "@haneoka/vega";
import { Application, BaseTexture, Container, Sprite, Texture, VERSION as PIXI_VERSION, filters } from "pixi.js";
import { SharedPixiTextureCache, type SharedPixiTextureLease } from "./SharedPixiTextureCache.js";
import { computeWebGalLayout } from "./webgalLayout.js";
export { computeWebGalLayout, type WebGalLayoutOptions, type WebGalPositioning } from "./webgalLayout.js";

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

interface PixiSeekPresentation {
  readonly version: 1;
  readonly world: readonly [number, number, number, number, number, number, number, number];
  readonly colorMatrix: readonly number[] | null;
  readonly screenEffects: readonly StoryScreenEffectSnapshot[];
  readonly characters: readonly {
    readonly target: string;
    readonly positionType: number;
    readonly brightness: number;
    readonly blur: number;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly worldPosition: { x: number; y: number } | null;
    readonly alpha: number;
    readonly angle: number;
  }[];
}

interface PixiTextureResource {
  readonly texture: Texture;
  readonly releaseRenderable: () => void;
  readonly estimatedBytes: number;
}

interface PixiTextureIdentity {
  readonly source: string;
  readonly bytes: Readonly<Uint8Array>;
  readonly forget: () => void;
}

interface PixiAnimation {
  readonly cancel: () => void;
}

interface LegacyPixiPrepare {
  upload(texture: Texture, done: () => void): void;
}

const pixiPrepareSupportsPromise = (() => {
  const [major = 0, minor = 0] = PIXI_VERSION.split(".").map(Number);
  return major > 6 || (major === 6 && minor >= 5);
})();

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
  values.map((value) => (typeof value === "string" ? value.trim() : "")).find(Boolean) ?? "";

const looksLikeImage = (source: string): boolean =>
  /^(?:blob:|data:image\/)/iu.test(source) || /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu.test(source);

export const pixiStaticCharacterSource = (entry: unknown): string => {
  const source = object(entry);
  const runtime = object(source.runtime);
  const model = firstString(runtime.model, runtime.modelUrl, source.model, source.modelUrl);
  const explicit = firstString(runtime.imageUrl, source.imageUrl, source.portraitUrl, runtime.source, source.source);
  if (explicit) return explicit;
  return looksLikeImage(model) ? model : "";
};

const backgroundSource = (entry: unknown): string => {
  const source = object(entry);
  return firstString(source.playableUrl, source.imageUrl, source.url, source.source);
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
  const scale = Math.min(safeWidth / safeReferenceWidth, safeHeight / safeReferenceHeight);
  const normalizeOffset = (value: number): number => (Math.abs(value) < Number.EPSILON * 512 ? 0 : value);
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

const waitForTexture = (texture: Texture, signal?: AbortSignal): Promise<void> => {
  if (texture.baseTexture.valid) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const loaded = () => {
      finish(resolve);
    };
    const failed = (_baseTexture: BaseTexture, error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error("Pixi texture failed to load")));
    };
    const aborted = () => finish(() => reject(abortReason(signal!)));
    const cleanup = () => {
      texture.baseTexture.off("loaded", loaded);
      texture.baseTexture.off("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    texture.baseTexture.once("loaded", loaded);
    texture.baseTexture.once("error", failed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
};

const abortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The Pixi resource request was aborted");
  error.name = "AbortError";
  return error;
};

const withAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
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

const DEFAULT_TEXTURE_CACHE_IDLE_ENTRIES = 48;
const DEFAULT_TEXTURE_CACHE_MEGABYTES = 384;
const BYTES_PER_RGBA_PIXEL = 4;

const estimateTextureBytes = (texture: Texture, sourceByteLength: number): number => {
  const pixelWidth = Math.max(1, finite(texture.baseTexture.realWidth, 1));
  const pixelHeight = Math.max(1, finite(texture.baseTexture.realHeight, 1));
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.ceil(pixelWidth * pixelHeight * BYTES_PER_RGBA_PIXEL) + Math.max(0, Math.trunc(sourceByteLength)),
  );
};

const pixiTextureBlobPart = (bytes: Readonly<Uint8Array>): Uint8Array<ArrayBuffer> => {
  if (bytes.buffer instanceof ArrayBuffer) {
    // Creating a view is allocation-only: the default Vega resolver's
    // canonical bytes reach Blob without another JavaScript byte copy.
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  // BlobPart deliberately excludes SharedArrayBuffer-backed views. Preserve
  // compatibility with custom resolvers by copying only that uncommon case.
  return Uint8Array.from(bytes);
};

const loadPixiTextureResource = async (
  identity: PixiTextureIdentity,
  signal: AbortSignal,
): Promise<PixiTextureResource> => {
  if (signal.aborted) throw abortReason(signal);
  const objectUrl = URL.createObjectURL(
    new Blob([pixiTextureBlobPart(identity.bytes)], {
      type: storyResourceContentType(identity.source, identity.bytes),
    }),
  );
  let objectUrlReleased = false;
  const releaseObjectUrl = (): void => {
    if (objectUrlReleased) return;
    objectUrlReleased = true;
    URL.revokeObjectURL(objectUrl);
  };
  let texture: Texture | undefined;
  try {
    texture = new Texture(new BaseTexture(objectUrl));
    await waitForTexture(texture, signal);
    return {
      texture,
      releaseRenderable: releaseObjectUrl,
      estimatedBytes: estimateTextureBytes(texture, identity.bytes.byteLength),
    };
  } catch (error) {
    try {
      texture?.destroy(true);
    } catch {
      // Preserve the load failure while still releasing the Blob URL below.
    } finally {
      releaseObjectUrl();
    }
    throw error;
  }
};

const canonicalTextureIdentities = new WeakMap<ArrayBufferLike, Map<string, PixiTextureIdentity>>();
const resolverTextureIdentities = new WeakMap<StoryResourceResolver, Map<string, PixiTextureIdentity>>();
const textureIdentityOwners = new WeakMap<PixiTextureIdentity, Set<Set<PixiTextureIdentity>>>();

const trackTextureIdentity = (identity: PixiTextureIdentity, owner: Set<PixiTextureIdentity>): void => {
  owner.add(identity);
  let owners = textureIdentityOwners.get(identity);
  if (!owners) {
    owners = new Set();
    textureIdentityOwners.set(identity, owners);
  }
  owners.add(owner);
};

const forgetTextureIdentity = (identity: PixiTextureIdentity): void => {
  identity.forget();
  const owners = textureIdentityOwners.get(identity);
  if (owners) {
    for (const owner of owners) owner.delete(identity);
    textureIdentityOwners.delete(identity);
  }
};

const releaseTextureIdentityOwner = (owner: Set<PixiTextureIdentity>): void => {
  for (const identity of owner) {
    const owners = textureIdentityOwners.get(identity);
    owners?.delete(owner);
    if (owners?.size === 0) textureIdentityOwners.delete(identity);
  }
  owner.clear();
};

const sameTextureBytes = (left: Readonly<Uint8Array>, right: Readonly<Uint8Array>): boolean => {
  if (left.buffer === right.buffer && left.byteOffset === right.byteOffset && left.byteLength === right.byteLength) {
    return true;
  }
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const textureIdentityFor = (
  source: string,
  resources: StoryResourceResolver,
  bytes: Readonly<Uint8Array>,
  sharedBytes: boolean,
): PixiTextureIdentity => {
  if (sharedBytes) {
    let identities = canonicalTextureIdentities.get(bytes.buffer);
    if (!identities) {
      identities = new Map();
      canonicalTextureIdentities.set(bytes.buffer, identities);
    }
    const viewKey = `${source}\u0000${bytes.byteOffset}:${bytes.byteLength}`;
    let identity = identities.get(viewKey);
    if (!identity) {
      let created!: PixiTextureIdentity;
      created = {
        source,
        bytes,
        forget: () => {
          if (identities.get(viewKey) === created) {
            identities.delete(viewKey);
          }
        },
      };
      identity = created;
      identities.set(viewKey, identity);
    }
    return identity;
  }

  let identities = resolverTextureIdentities.get(resources);
  if (!identities) {
    identities = new Map();
    resolverTextureIdentities.set(resources, identities);
  }
  let identity = identities.get(source);
  if (!identity || !sameTextureBytes(identity.bytes, bytes)) {
    let created!: PixiTextureIdentity;
    created = {
      source,
      bytes,
      forget: () => {
        if (identities.get(source) === created) identities.delete(source);
      },
    };
    identity = created;
    identities.set(source, identity);
  }
  return identity;
};

const sharedTextureCache = new SharedPixiTextureCache<PixiTextureIdentity, PixiTextureResource>(
  loadPixiTextureResource,
  (resource) => {
    try {
      resource.texture.destroy(true);
    } finally {
      resource.releaseRenderable();
    }
  },
  DEFAULT_TEXTURE_CACHE_IDLE_ENTRIES,
  (resource) => resource.estimatedBytes,
  DEFAULT_TEXTURE_CACHE_MEGABYTES * 1024 * 1024,
  forgetTextureIdentity,
);

/**
 * Pixi owns stage pixels; GenericStoryScene remains the command-complete
 * fallback for DOM UI, video, rule transitions, saves and unsupported assets.
 */
export class PixiStoryScene extends GenericStoryScene {
  readonly backend: string;
  readonly profile: "vega" | "webgal";
  protected readonly context: StorySceneBackendContext;
  protected readonly options: Required<
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
  protected app: Application | null = null;
  private pixiRoot: HTMLElement | null = null;
  private readonly viewportWorld = new Container();
  protected readonly world = new Container();
  private readonly pixiBackgroundLayer = new Container();
  private readonly pixiCharacterLayer = new Container();
  private readonly pixiStillLayer = new Container();
  private readonly pixiEffectLayer = new Container();
  protected pixiBackgroundLease: PixiLease | null = null;
  private pixiStillLease: PixiLease | null = null;
  protected readonly pixiCharacters = new Map<string, PixiCharacter>();
  private readonly screenEffects: StoryScreenEffects;
  private screenSprites: PixiScreenSpriteRenderer | undefined;
  private readonly pixiBackgroundEffects = new Container();
  private screenEffectRenderLease: (() => void) | undefined;
  private readonly tickScreenEffects = (delta: number) => {
    if (!this.pixiDeterministicReplay) {
      this.screenEffects.update(delta / 60);
      this.syncScreenEffects();
    }
  };
  get screenEffectKeys(): readonly string[] {
    return this.screenEffects.keys;
  }
  async setScreenEffect(key: string, definition: StoryScreenEffectDefinition, signal?: AbortSignal): Promise<void> {
    await this.screenEffects.set(key, definition, signal);
  }
  clearScreenEffects(key?: string): void {
    this.screenEffects.clear(key);
  }
  private syncScreenEffects(): void {
    this.screenSprites?.sync(this.screenEffects.batches);
    const animated = this.screenEffects.batches.some((batch) => batch.instances.length > 0);
    if (animated && !this.screenEffectRenderLease) this.screenEffectRenderLease = this.retainContinuousRender();
    else if (!animated && this.screenEffectRenderLease) {
      this.screenEffectRenderLease();
      this.screenEffectRenderLease = undefined;
    }
    this.requestRender();
  }
  private readonly textureCache: SharedPixiTextureCache<PixiTextureIdentity, PixiTextureResource>;
  private readonly textureCacheKeys = new Set<PixiTextureIdentity>();
  private readonly episodeTextureLeases = new Map<PixiTextureIdentity, SharedPixiTextureLease<PixiTextureResource>>();
  private readonly texturePreparations = new WeakMap<Texture, Promise<void>>();
  private readonly pendingTexturePreparations = new Set<Promise<void>>();
  private releaseTextureCacheLimits: (() => void) | null;
  private viewport: PixiViewport = computePixiViewport(1, 1);
  private observer: ResizeObserver | null = null;
  private readonly lifecycleController = new AbortController();
  private backgroundGeneration = 0;
  private stillGeneration = 0;
  private readonly characterGenerations = new Map<string, number>();
  protected readonly animations = new Map<string, PixiAnimation>();
  private colorMatrixFilter: InstanceType<typeof ColorMatrixFilter> | null = null;
  private pixiBackgroundBrightness = 1;
  private pixiBackgroundBlur = 0;
  protected pixiDeterministicReplay = false;
  protected pixiDestroyed = false;
  private pixiDestroyComplete = false;
  private destroyPromise: Promise<void> | null = null;
  private releaseTexturesRequested = false;
  private continuousRenderReferences = 0;
  private renderQueued = false;

  constructor(context: StorySceneBackendContext, options: PixiRendererOptions = {}) {
    super(context.runtime, context.state, context.resources, {
      ...(context.characterProviders ? { characterProviders: context.characterProviders } : {}),
    });
    this.context = context;
    this.screenEffects = new StoryScreenEffects(
      context.signal,
      async (definition, signal) => {
        const contribution = context.rendererExtensions?.effects.find(
          (effect) => effect.effectType === definition.effectType,
        );
        if (!contribution) throw new Error(`Screen effect provider is unavailable: ${definition.effectType}`);
        if (!this.app) throw new Error("The renderer is not ready for screen effects");
        const effect = await contribution.create(
          definition,
          {
            renderer: this.backend,
            rendererContext: { app: this.app, world: this.world },
            runtime: context.runtime,
            state: context.state,
            resources: context.resources,
            signal,
            service: (key) => context.rendererExtensions?.service(key),
          },
          signal,
        );
        if (!isStoryScreenSpriteEffect(effect)) {
          if (typeof effect === "function") await effect();
          else if ("dispose" in effect) await effect.dispose();
          else if ("destroy" in effect) await effect.destroy();
          else await effect.close();
          throw new TypeError("The effect provider does not expose screen sprites");
        }
        return effect;
      },
      () => this.syncScreenEffects(),
    );
    this.textureCache = sharedTextureCache;
    this.releaseTextureCacheLimits = this.textureCache.registerLimits(
      Math.max(8, Math.trunc(finite(context.runtime.textureCacheEntryMax, DEFAULT_TEXTURE_CACHE_IDLE_ENTRIES))),
      Math.max(0, finite(context.runtime.textureCacheMegabytes, DEFAULT_TEXTURE_CACHE_MEGABYTES)) * 1024 * 1024,
    );
    this.backend = options.backend || "pixi";
    this.profile = options.profile || "vega";
    this.options = {
      referenceWidth: positive(options.referenceWidth, this.profile === "webgal" ? 2560 : 1920),
      referenceHeight: positive(options.referenceHeight, this.profile === "webgal" ? 1440 : 1080),
      backgroundColor: Math.trunc(finite(options.backgroundColor, 0x050713)),
      antialias: options.antialias ?? true,
      autoDensity: options.autoDensity ?? true,
      maxResolution: positive(options.maxResolution, 2),
      profile: this.profile,
    };
    this.viewportWorld.addChild(this.world);
    this.world.sortableChildren = true;
    this.pixiBackgroundLayer.zIndex = 0;
    this.pixiBackgroundEffects.zIndex = 5;
    this.pixiBackgroundEffects.sortableChildren = true;
    this.pixiEffectLayer.sortableChildren = true;
    this.pixiCharacterLayer.zIndex = 10;
    this.pixiStillLayer.zIndex = 20;
    this.pixiEffectLayer.zIndex = 30;
    this.world.addChild(
      this.pixiBackgroundLayer,
      this.pixiBackgroundEffects,
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
    const roots = mount.querySelectorAll<HTMLElement>('[data-vega-scene="generic"]');
    const root = roots.item(roots.length - 1);
    if (!root) throw new Error("Vega Pixi renderer could not find its stage root");
    const resolution = Math.min(this.options.maxResolution, Math.max(1, finite(globalThis.devicePixelRatio, 1)));
    const app = new Application({
      width: Math.max(1, root.clientWidth),
      height: Math.max(1, root.clientHeight),
      backgroundColor: this.options.backgroundColor,
      antialias: this.options.antialias,
      autoDensity: this.options.autoDensity,
      resolution,
      powerPreference: "high-performance",
      sharedTicker: false,
      autoStart: false,
    });
    const interaction = app.renderer.plugins.interaction as { useSystemTicker?: boolean } | undefined;
    if (interaction && "useSystemTicker" in interaction) {
      // Vega routes input through its DOM shell; Pixi has no interactive stage
      // objects, so its global interaction ticker would only keep an idle rAF.
      interaction.useSystemTicker = false;
    }
    const canvas = app.view as HTMLCanvasElement;
    canvas.className = "vega-stage__pixi";
    canvas.dataset.vegaRenderer = "pixi";
    canvas.style.cssText = "position:absolute;inset:0;z-index:0;width:100%;height:100%;display:block;";
    root.prepend(canvas);
    root.dataset.vegaScene = "pixi";
    root.dataset.vegaPixiProfile = this.profile;
    app.stage.addChild(this.viewportWorld);
    this.pixiRoot = root;
    this.app = app;
    this.screenSprites = new PixiScreenSpriteRenderer(this.pixiBackgroundEffects, this.pixiEffectLayer);
    app.ticker.add(this.tickScreenEffects);
    this.resize();
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(root);
    }
    this.requestRender();
  }

  override destroy(
    options: {
      releaseTextures?: boolean;
    } = {},
  ): Promise<void> {
    if (options.releaseTextures !== false) {
      this.releaseTexturesRequested = true;
      this.textureCache.disposeWhenIdle(this.textureCacheKeys);
      if (this.pixiDestroyComplete) {
        releaseTextureIdentityOwner(this.textureCacheKeys);
      }
    }
    if (this.destroyPromise) return this.destroyPromise;
    this.pixiDestroyed = true;
    this.destroyPromise = Promise.resolve().then(() => this.destroyScene());
    return this.destroyPromise;
  }

  private async destroyScene(): Promise<void> {
    this.lifecycleController.abort();
    this.backgroundGeneration += 1;
    this.stillGeneration += 1;
    for (const target of this.characterGenerations.keys()) {
      this.characterGenerations.set(target, (this.characterGenerations.get(target) ?? 0) + 1);
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
    for (const lease of this.episodeTextureLeases.values()) lease.release();
    this.episodeTextureLeases.clear();
    this.app?.ticker.remove(this.tickScreenEffects);
    this.screenEffects.dispose();
    this.screenSprites?.dispose();
    this.screenSprites = undefined;
    this.continuousRenderReferences = 0;
    this.clearColorMatrix();
    // Pixi 6's prepare plugin drops queued completion callbacks when its
    // renderer is destroyed. Let already-started GPU uploads finish first so
    // aborted callers can safely release their shared texture leases.
    if (this.pendingTexturePreparations.size > 0) {
      await Promise.allSettled([...this.pendingTexturePreparations]);
    }
    if (this.app) {
      this.app.stop();
      this.app.destroy(true, {
        children: true,
        texture: false,
        baseTexture: false,
      });
    }
    this.app = null;
    this.pixiRoot = null;
    try {
      await super.destroy();
    } finally {
      // A destroy(false) may be upgraded while GenericStoryScene is still
      // disposing provider models. Sweep again so that upgrade is monotonic.
      if (this.releaseTexturesRequested) {
        this.textureCache.disposeWhenIdle(this.textureCacheKeys);
        releaseTextureIdentityOwner(this.textureCacheKeys);
      }
      this.releaseTextureCacheLimits?.();
      this.releaseTextureCacheLimits = null;
      this.pixiDestroyComplete = true;
    }
  }

  override resize(): void {
    super.resize();
    const root = this.pixiRoot;
    const app = this.app;
    if (!root || !app) return;
    const width = Math.max(1, root.clientWidth);
    const height = Math.max(1, root.clientHeight);
    app.renderer.resize(width, height);
    this.viewport = computePixiViewport(width, height, this.options.referenceWidth, this.options.referenceHeight);
    Object.assign(this.context.state.viewport, {
      x: this.viewport.offsetX,
      y: this.viewport.offsetY,
      width: this.options.referenceWidth * this.viewport.scale,
      height: this.options.referenceHeight * this.viewport.scale,
      surfaceWidth: width,
      surfaceHeight: height,
    });
    this.viewportWorld.position.set(this.viewport.offsetX, this.viewport.offsetY);
    this.viewportWorld.scale.set(this.viewport.scale);
    this.fitLease(this.pixiBackgroundLease, "cover");
    this.fitLease(this.pixiStillLease, "contain");
    for (const character of this.pixiCharacters.values()) {
      this.layoutCharacter(character);
    }
    this.requestRender();
  }

  capturePreview(options: StoryScenePreviewOptions): string | undefined {
    const app = this.app;
    const document = this.pixiRoot?.ownerDocument;
    if (!app || !document?.createElement) return undefined;
    try {
      // Extract the rendered framebuffer. Extracting `app.stage` renders its
      // content bounds into a transparent texture: empty margins disappear,
      // narrow portraits are zoomed/cropped, and the stage clear colour is lost.
      app.render();
      const source = app.renderer.plugins.extract.canvas();
      if (!source.width || !source.height) return undefined;
      const preview = document.createElement("canvas");
      preview.width = Math.max(1, Math.round(options.width));
      preview.height = Math.max(1, Math.round(options.height));
      const context = preview.getContext("2d");
      if (!context) return undefined;
      const scale = Math.max(preview.width / source.width, preview.height / source.height);
      const width = source.width * scale;
      const height = source.height * scale;
      context.drawImage(source, (preview.width - width) / 2, (preview.height - height) / 2, width, height);
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
    if (active) this.app?.stop();
    else if (this.continuousRenderReferences > 0) this.app?.start();
    else this.requestRender();
  }

  override createSeekSnapshot(): ReturnType<GenericStoryScene["createSeekSnapshot"]> {
    if (!this.screenEffects.ready) return null;
    const snapshot = super.createSeekSnapshot();
    if (!snapshot) return null;
    const presentation: PixiSeekPresentation = {
      version: 1,
      world: [
        this.world.x,
        this.world.y,
        this.world.scale.x,
        this.world.scale.y,
        this.world.pivot.x,
        this.world.pivot.y,
        this.world.rotation,
        this.world.alpha,
      ],
      colorMatrix: this.colorMatrixFilter ? Array.from(this.colorMatrixFilter.matrix) : null,
      screenEffects: this.screenEffects.snapshot(),
      characters: [...this.pixiCharacters.values()].map((character) => ({
        target: character.target,
        positionType: character.positionType,
        brightness: character.brightness,
        blur: character.blur,
        offsetX: character.offsetX,
        offsetY: character.offsetY,
        worldPosition: character.worldPosition ? { ...character.worldPosition } : null,
        alpha: character.sprite.alpha,
        angle: character.sprite.angle,
      })),
    };
    return { ...snapshot, rendererState: { ...object(snapshot.rendererState), pixi: presentation } };
  }

  override async restoreSeekSnapshot(
    snapshot: Parameters<GenericStoryScene["restoreSeekSnapshot"]>[0],
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted || this.pixiDestroyed) return;
    this.cancelAllAnimations();
    await super.restoreSeekSnapshot(snapshot);
    if (signal?.aborted || this.pixiDestroyed) return;
    const presentation = object(snapshot.rendererState).pixi as PixiSeekPresentation | undefined;
    this.clearScreenEffects();
    this.clearColorMatrix();
    if (presentation?.version !== 1) {
      this.setWorldTransform({});
      return;
    }
    const [x, y, sx, sy, px, py, rotation, alpha] = presentation.world;
    this.world.position.set(x, y);
    this.world.scale.set(sx, sy);
    this.world.pivot.set(px, py);
    this.world.rotation = rotation;
    this.world.alpha = alpha;
    if (presentation.colorMatrix) this.applyColorMatrix(presentation.colorMatrix);
    const targets = new Set(presentation.characters.map((character) => character.target));
    for (const [target, character] of this.pixiCharacters) {
      if (targets.has(target)) continue;
      this.releasePixiCharacter(character);
      this.pixiCharacters.delete(target);
    }
    for (const saved of presentation.characters) {
      const character = this.pixiCharacters.get(saved.target);
      if (!character) continue;
      character.positionType = saved.positionType;
      character.brightness = saved.brightness;
      character.blur = saved.blur;
      character.offsetX = saved.offsetX;
      character.offsetY = saved.offsetY;
      character.worldPosition = saved.worldPosition ? { ...saved.worldPosition } : null;
      character.sprite.alpha = saved.alpha;
      character.sprite.angle = saved.angle;
      character.sprite.tint = tintFromBrightness(saved.brightness);
      this.setBlur(character.sprite, saved.blur);
      this.layoutCharacter(character);
    }
    await this.screenEffects.restore(presentation.screenEffects ?? [], signal);
    this.requestRender();
  }

  cancelTransitionsForSeek(): void {
    this.cancelAllAnimations();
  }

  presentSeekSnapshot(): void {
    if (!this.pixiDestroyed) this.app?.render();
  }

  override async preloadTexture(url: string, signal?: AbortSignal): Promise<Readonly<Uint8Array>> {
    if (!url) throw new Error("Cannot load an empty Pixi texture URL");
    const linked = linkSignals([this.context.signal, this.lifecycleController.signal, signal]);
    const domReady = super.preloadTexture(url, linked.signal);
    // Keep the parallel DOM fallback preparation observed even if Pixi fails
    // first, so an aborted preload never creates an unhandled rejection.
    void domReady.catch(() => undefined);
    let lease: SharedPixiTextureLease<PixiTextureResource> | undefined;
    let identity: PixiTextureIdentity | undefined;
    try {
      // Pixi owns its decoded/GPU texture lifetime. Read canonical bytes in
      // parallel with the DOM fallback decode so either rendering path is
      // ready before the episode leaves its loading screen.
      const sharedBytes = this.context.resources.loadSharedBytes;
      const bytes = await (sharedBytes
        ? sharedBytes.call(this.context.resources, url, linked.signal)
        : this.context.resources.load(url, linked.signal));
      identity = textureIdentityFor(url, this.context.resources, bytes, Boolean(sharedBytes));
      const resident = this.episodeTextureLeases.get(identity);
      if (resident) {
        await withAbort(this.texturePreparation(resident.value.texture), linked.signal);
        await domReady;
        return bytes;
      }
      lease = await this.textureCache.acquire(identity, linked.signal);
      trackTextureIdentity(identity, this.textureCacheKeys);
      if (linked.signal.aborted) throw abortReason(linked.signal);
      const preparation = this.texturePreparation(lease.value.texture);
      await withAbort(preparation, linked.signal);
      if (linked.signal.aborted) throw abortReason(linked.signal);
      const raced = this.episodeTextureLeases.get(identity);
      if (raced) {
        lease.release();
      } else {
        this.episodeTextureLeases.set(identity, lease);
      }
      lease = undefined;
      await domReady;
      return bytes;
    } finally {
      if (lease) {
        this.releaseTextureLeaseAfterPreparation(lease, this.texturePreparations.get(lease.value.texture));
      }
      if (identity && this.releaseTexturesRequested) {
        this.textureCache.disposeWhenIdle([identity]);
      }
      if (identity && !lease && !this.textureCache.has(identity)) {
        forgetTextureIdentity(identity);
      }
      linked.release();
    }
  }

  override loadTexture(url: string, signal?: AbortSignal): Promise<Readonly<Uint8Array>> {
    return this.preloadTexture(url, signal);
  }

  override async preloadCharacter(
    request: Parameters<GenericStoryScene["preloadCharacter"]>[0],
    signal?: AbortSignal,
  ): Promise<boolean> {
    const portableReady = super.preloadCharacter(request, signal);
    const source = pixiStaticCharacterSource(request.command.characterModel);
    if (!source) return portableReady;
    // Generic prepares the portable DOM controller; retain the matching Pixi
    // GPU texture as well so sprite selection has no first-use upload.
    const [ready] = await Promise.all([portableReady, this.preloadTexture(source, signal)]);
    return ready;
  }

  override async setBackground(...args: Parameters<GenericStoryScene["setBackground"]>): Promise<boolean> {
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
    const lease = await this.createSpriteLease(source, args[3] ?? this.context.signal);
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
    this.requestRender();
    return result;
  }

  override async setStill(...args: Parameters<GenericStoryScene["setStill"]>): Promise<void> {
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
    this.requestRender();
  }

  override async clearStill(...args: Parameters<GenericStoryScene["clearStill"]>): Promise<void> {
    const generation = ++this.stillGeneration;
    await super.clearStill(...args);
    if (generation !== this.stillGeneration || this.pixiDestroyed) return;
    this.releasePixiLease(this.pixiStillLease);
    this.pixiStillLease = null;
    this.showDomLayer("still");
  }

  override async fadeStill(...args: Parameters<GenericStoryScene["fadeStill"]>): Promise<void> {
    const lease = this.pixiStillLease;
    const animation = lease
      ? this.animateNumber("still:alpha", lease.sprite.alpha, clamp(args[0]), finite(args[1]), (value) => {
          if (this.pixiStillLease === lease) lease.sprite.alpha = value;
        })
      : Promise.resolve();
    await Promise.all([super.fadeStill(...args), animation]);
  }

  override async placeCharacter(...args: Parameters<GenericStoryScene["placeCharacter"]>): Promise<void> {
    const [command, positionType] = args;
    const target = firstString(command.targetName, command.targets?.[0]?.target, command.characterKey);
    const generation = target ? (this.characterGenerations.get(target) ?? 0) + 1 : 0;
    if (target) this.characterGenerations.set(target, generation);
    await super.placeCharacter(...args);
    if (!target || generation !== this.characterGenerations.get(target) || this.pixiDestroyed) {
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
    if (generation !== this.characterGenerations.get(target) || this.pixiDestroyed) {
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
    this.requestRender();
  }

  override async removeCharacter(...args: Parameters<GenericStoryScene["removeCharacter"]>): Promise<boolean> {
    const target = args[0];
    this.characterGenerations.set(target, (this.characterGenerations.get(target) ?? 0) + 1);
    const character = this.pixiCharacters.get(target);
    const animation = character
      ? this.animateNumber(`character:${target}:alpha`, character.sprite.alpha, 0, finite(args[1]), (value) => {
          if (this.pixiCharacters.get(target) === character) {
            character.sprite.alpha = value;
          }
        })
      : Promise.resolve();
    const [result] = await Promise.all([super.removeCharacter(...args), animation]);
    if (character) {
      this.cancelAnimations(`character:${target}:`);
      this.releasePixiCharacter(character);
      this.pixiCharacters.delete(target);
    }
    this.showDomCharacter(target);
    return result;
  }

  override async fadeCharacter(...args: Parameters<GenericStoryScene["fadeCharacter"]>): Promise<void> {
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

  override async moveCharacter(...args: Parameters<GenericStoryScene["moveCharacter"]>): Promise<void> {
    await super.moveCharacter(...args);
    const [positionType, offset] = args;
    for (const character of this.pixiCharacters.values()) {
      if (character.positionType !== positionType) continue;
      character.worldPosition = null;
      character.offsetX += finite(offset.x);
      character.offsetY += finite(offset.y);
      this.layoutCharacter(character);
    }
    this.requestRender();
  }

  override async moveCharacterToWorld(...args: Parameters<GenericStoryScene["moveCharacterToWorld"]>): Promise<void> {
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
    this.requestRender();
  }

  override async setCharacterAngle(...args: Parameters<GenericStoryScene["setCharacterAngle"]>): Promise<void> {
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

  override async setBrightness(...args: Parameters<GenericStoryScene["setBrightness"]>): Promise<void> {
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

  override async setCharacterDoF(...args: Parameters<GenericStoryScene["setCharacterDoF"]>): Promise<void> {
    const character = this.pixiCharacters.get(args[0]);
    const destination = clamp(args[1]);
    const animation = character
      ? this.animateNumber(`character:${args[0]}:blur`, character.blur, destination, finite(args[2]), (value) => {
          if (this.pixiCharacters.get(args[0]) !== character) return;
          character.blur = value;
          this.setBlur(character.sprite, value);
        })
      : Promise.resolve();
    await Promise.all([super.setCharacterDoF(...args), animation]);
  }

  override async setBackgroundDoF(...args: Parameters<GenericStoryScene["setBackgroundDoF"]>): Promise<void> {
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
      referenceSize: [this.options.referenceWidth, this.options.referenceHeight] as const,
      viewport: { ...this.viewport },
      characters: [...this.pixiCharacters.keys()].sort(),
      background: Boolean(this.pixiBackgroundLease),
      still: Boolean(this.pixiStillLease),
      effects: [...this.screenEffects.keys].sort(),
    });
  }

  setWorldTransform(transform: {
    readonly x?: number;
    readonly y?: number;
    readonly scale?: number;
    readonly rotationDegrees?: number;
  }): void {
    const scale = positive(transform.scale, 1);
    this.world.pivot.set(this.options.referenceWidth / 2, this.options.referenceHeight / 2);
    this.world.position.set(
      this.options.referenceWidth * 0.5 + finite(transform.x),
      this.options.referenceHeight * 0.5 + finite(transform.y),
    );
    this.world.scale.set(scale);
    this.world.rotation = (finite(transform.rotationDegrees) * Math.PI) / 180;
    this.requestRender();
  }

  applyColorMatrix(values: readonly number[]): void {
    if (values.length !== 20 || values.some((value) => !Number.isFinite(value))) {
      throw new TypeError("A Pixi color matrix must contain 20 finite values");
    }
    const filter = this.colorMatrixFilter ?? new ColorMatrixFilter();
    this.colorMatrixFilter = filter;
    filter.matrix = [...values] as unknown as typeof filter.matrix;
    if (!(this.world.filters ?? []).includes(filter)) {
      this.world.filters = [...(this.world.filters ?? []), filter];
    }
    this.requestRender();
  }

  clearColorMatrix(): void {
    const filter = this.colorMatrixFilter;
    if (!filter) return;
    this.world.filters = (this.world.filters ?? []).filter((candidate) => candidate !== filter);
    filter.destroy();
    this.colorMatrixFilter = null;
    this.requestRender();
  }

  protected requestRender(): void {
    const app = this.app;
    if (!app || this.pixiDestroyed || this.pixiDeterministicReplay || app.ticker.started || this.renderQueued) {
      return;
    }
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      const current = this.app;
      if (!current || this.pixiDestroyed || this.pixiDeterministicReplay || current.ticker.started) return;
      current.render();
    });
  }

  protected retainContinuousRender(): () => void {
    const app = this.app;
    if (!app || this.pixiDestroyed) return () => undefined;
    this.continuousRenderReferences += 1;
    if (!this.pixiDeterministicReplay) app.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.continuousRenderReferences = Math.max(0, this.continuousRenderReferences - 1);
      if (this.continuousRenderReferences !== 0 || this.app !== app) return;
      app.stop();
      this.requestRender();
    };
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
      this.requestRender();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let elapsed = 0;
      let settled = false;
      let animation: PixiAnimation;
      let releaseContinuousRender: () => void = () => undefined;
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
        releaseContinuousRender();
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
      releaseContinuousRender = this.retainContinuousRender();
      if (this.lifecycleController.signal.aborted || this.context.signal.aborted) {
        cancel();
      }
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

  private async createSpriteLease(source: string, externalSignal?: AbortSignal): Promise<PixiLease> {
    const linked = linkSignals([this.context.signal, this.lifecycleController.signal, externalSignal]);
    let textureLease: SharedPixiTextureLease<PixiTextureResource> | undefined;
    let identity: PixiTextureIdentity | undefined;
    try {
      const sharedBytes = this.context.resources.loadSharedBytes;
      const bytes = await (sharedBytes
        ? sharedBytes.call(this.context.resources, source, linked.signal)
        : this.context.resources.load(source, linked.signal));
      identity = textureIdentityFor(source, this.context.resources, bytes, Boolean(sharedBytes));
      textureLease = await this.textureCache.acquire(identity, linked.signal);
      trackTextureIdentity(identity, this.textureCacheKeys);
      if (linked.signal.aborted) throw abortReason(linked.signal);
      const preparation = this.texturePreparation(textureLease.value.texture);
      await withAbort(preparation, linked.signal);
      if (linked.signal.aborted) throw abortReason(linked.signal);
      const sprite = new Sprite(textureLease.value.texture);
      let released = false;
      return {
        sprite,
        release: () => {
          if (released) return;
          released = true;
          textureLease?.release();
        },
      };
    } catch (error) {
      if (textureLease) {
        this.releaseTextureLeaseAfterPreparation(
          textureLease,
          this.texturePreparations.get(textureLease.value.texture),
        );
      }
      if (identity && this.releaseTexturesRequested) {
        this.textureCache.disposeWhenIdle([identity]);
      }
      if (identity && !textureLease && !this.textureCache.has(identity)) {
        forgetTextureIdentity(identity);
      }
      throw error;
    } finally {
      linked.release();
    }
  }

  private texturePreparation(texture: Texture): Promise<void> {
    const app = this.app;
    if (!app || this.pixiDestroyed) {
      throw new Error("Pixi renderer must be set up before loading textures");
    }
    const existing = this.texturePreparations.get(texture);
    if (existing) return existing;
    const prepare = app.renderer.plugins.prepare;
    const pending = pixiPrepareSupportsPromise
      ? Promise.resolve(prepare.upload(texture))
      : new Promise<void>((resolve, reject) => {
          try {
            // Pixi 6.3-6.4 only expose the callback API. Keep that peer-range
            // fallback isolated so 6.5+ never invokes its deprecated overload.
            (prepare as unknown as LegacyPixiPrepare).upload(texture, resolve);
          } catch (error) {
            reject(error);
          }
        });
    this.texturePreparations.set(texture, pending);
    this.pendingTexturePreparations.add(pending);
    void pending.then(
      () => {
        this.pendingTexturePreparations.delete(pending);
      },
      () => {
        this.pendingTexturePreparations.delete(pending);
        if (this.texturePreparations.get(texture) === pending) {
          this.texturePreparations.delete(texture);
        }
      },
    );
    return pending;
  }

  private releaseTextureLeaseAfterPreparation(
    lease: SharedPixiTextureLease<PixiTextureResource>,
    preparation?: Promise<void>,
  ): void {
    if (!preparation) {
      lease.release();
      return;
    }
    void preparation.then(
      () => lease.release(),
      () => lease.release(),
    );
  }

  protected fitLease(lease: PixiLease | null, mode: "cover" | "contain"): void {
    if (!lease) return;
    const width = positive(lease.sprite.texture.width, this.options.referenceWidth);
    const height = positive(lease.sprite.texture.height, this.options.referenceHeight);
    const scale =
      mode === "cover"
        ? Math.max(this.options.referenceWidth / width, this.options.referenceHeight / height)
        : Math.min(this.options.referenceWidth / width, this.options.referenceHeight / height);
    lease.sprite.position.set(this.options.referenceWidth / 2, this.options.referenceHeight / 2);
    lease.sprite.scale.set(scale);
  }

  protected layoutCharacter(character: PixiCharacter): void {
    if (this.profile === "webgal") {
      const layout = computeWebGalLayout({
        stageWidth: this.options.referenceWidth,
        stageHeight: this.options.referenceHeight,
        width: character.sprite.texture.width,
        height: character.sprite.texture.height,
        position: character.positionType === 1 ? "left" : character.positionType === 9 ? "right" : "center",
      });
      character.sprite.anchor.set(0.5);
      character.sprite.position.set(layout.x + character.offsetX * 96, layout.y - character.offsetY * 54);
      character.sprite.scale.set(layout.scale);
      return;
    }
    const point = this.stagePoint(character.positionType);
    const stageWidth = Math.max(0.001, finite(this.context.runtime.stage.width, 3.2));
    const unitX = (this.options.referenceWidth * 0.84) / stageWidth;
    const unitY = (this.options.referenceHeight * 0.84) / stageWidth;
    const x = character.worldPosition
      ? this.options.referenceWidth / 2 + character.worldPosition.x * unitX
      : this.options.referenceWidth / 2 +
        (point.x / Math.max(0.001, finite(this.context.runtime.stage.maxX, 1.6))) *
          (this.options.referenceWidth * 0.42) +
        character.offsetX * unitX;
    const y = character.worldPosition
      ? this.options.referenceHeight - character.worldPosition.y * unitY
      : this.options.referenceHeight - character.offsetY * unitY;
    const sourceHeight = positive(character.sprite.texture.height, this.options.referenceHeight);
    const scale = (this.options.referenceHeight * 0.94) / sourceHeight;
    character.sprite.position.set(x, y);
    character.sprite.scale.set(scale);
  }

  private hideDomLayer(name: string): void {
    const layer = this.pixiRoot?.querySelector<HTMLElement>(`[data-vega-layer="${name}"]`);
    if (layer) layer.style.visibility = "hidden";
  }

  private showDomLayer(name: string): void {
    const layer = this.pixiRoot?.querySelector<HTMLElement>(`[data-vega-layer="${name}"]`);
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
    const escaped = globalThis.CSS?.escape?.(target) ?? target.replace(/["\\]/gu, (character) => `\\${character}`);
    return this.pixiRoot?.querySelector<HTMLElement>(`[data-vega-character="${escaped}"]`) ?? null;
  }

  private setBlur(sprite: Sprite, intensity: number): void {
    const filters = sprite.filters ?? [];
    const existing = filters.find(
      (candidate): candidate is InstanceType<typeof BlurFilter> => candidate instanceof BlurFilter,
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
      this.setBlur(lease.sprite, 0);
      lease.sprite.destroy({
        children: true,
        texture: false,
        baseTexture: false,
      });
    } finally {
      lease.release();
      this.requestRender();
    }
  }

  private releasePixiCharacter(character: PixiCharacter): void {
    try {
      this.setBlur(character.sprite, 0);
      character.sprite.destroy({
        children: true,
        texture: false,
        baseTexture: false,
      });
    } finally {
      character.lease();
      this.requestRender();
    }
  }
}

export const createPixiRendererPlugin = (options: PixiRendererOptions = {}): VegaPlugin =>
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
