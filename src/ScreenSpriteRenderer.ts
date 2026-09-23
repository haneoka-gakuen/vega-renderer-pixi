import { BaseTexture, Container, Matrix, ParticleContainer, Rectangle, Sprite, Texture } from "pixi.js";
import type { StoryScreenSpriteBatch } from "@haneoka/vega/renderer-kit";
interface ImageTextures {
  base: BaseTexture;
  frames: Map<string, Texture>;
  references: number;
}
interface View {
  batch: StoryScreenSpriteBatch;
  container: Container;
  sprites: Sprite[];
  revision: number;
}
const pixel = (value: number) => (Math.abs(value - Math.round(value)) < 0.001 ? Math.round(value) : value);
export class PixiScreenSpriteRenderer {
  private readonly views = new Map<StoryScreenSpriteBatch, View>();
  private readonly images = new Map<object, ImageTextures>();
  constructor(
    private readonly background: Container,
    private readonly foreground: Container,
  ) {}
  sync(batches: readonly StoryScreenSpriteBatch[]): void {
    const retained = new Set(batches);
    for (const [batch, view] of this.views)
      if (!retained.has(batch)) {
        view.container.parent?.removeChild(view.container);
        view.container.destroy({ children: true, texture: false, baseTexture: false });
        this.views.delete(batch);
        const image = this.images.get(batch.image.source)!;
        if (--image.references === 0) {
          for (const frame of image.frames.values()) frame.destroy(false);
          image.base.destroy();
          this.images.delete(batch.image.source);
        }
      }
    batches.forEach((batch, index) => {
      let view = this.views.get(batch),
        image = this.images.get(batch.image.source);
      if (!image) {
        image = { base: new BaseTexture(batch.image.source as HTMLImageElement), frames: new Map(), references: 0 };
        this.images.set(batch.image.source, image);
      }
      if (!view) {
        image.references++;
        const container = new Container(),
          particles = new ParticleContainer(Math.max(1, batch.instances.length / 10), {
            position: true,
            rotation: true,
            vertices: true,
            tint: true,
            uvs: true,
          });
        container.addChild(particles);
        container.transform.setFromMatrix(new Matrix(...batch.transform));
        (batch.layer === "background" ? this.background : this.foreground).addChild(container);
        const sprites: Sprite[] = [];
        for (let i = 0; i < batch.instances.length / 10; i++) {
          const sprite = new Sprite(Texture.EMPTY);
          sprite.anchor.set(0.5);
          particles.addChild(sprite);
          sprites.push(sprite);
        }
        view = { batch, container, sprites, revision: -1 };
        this.views.set(batch, view);
      }
      view.container.zIndex = index;
      if (view.revision === batch.revision) return;
      const data = batch.instances;
      view.sprites.forEach((sprite, index) => {
        const offset = index * 10,
          u0 = data[offset + 6]!,
          v0 = data[offset + 7]!,
          u1 = data[offset + 8]!,
          v1 = data[offset + 9]!;
        const key = `${u0},${v0},${u1},${v1}`;
        let texture = image!.frames.get(key);
        if (!texture) {
          const x = pixel(u0 * batch.image.width),
            y = pixel(v0 * batch.image.height),
            right = pixel(u1 * batch.image.width),
            bottom = pixel(v1 * batch.image.height);
          texture = new Texture(image!.base, new Rectangle(x, y, right - x, bottom - y));
          image!.frames.set(key, texture);
        }
        sprite.texture = texture;
        sprite.position.set(data[offset]!, data[offset + 1]!);
        sprite.rotation = data[offset + 2]!;
        sprite.scale.set(
          (data[offset + 3]! * batch.width) / texture.orig.width,
          (data[offset + 4]! * batch.height) / texture.orig.height,
        );
        sprite.alpha = data[offset + 5]!;
        sprite.tint = batch.tint;
      });
      view.revision = batch.revision;
    });
  }
  dispose(): void {
    this.sync([]);
  }
}
