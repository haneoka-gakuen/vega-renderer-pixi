# Vega Pixi Renderer

The Pixi renderer draws a [Vega](https://github.com/haneoka-gakuen/vega)
story on the GPU with [PixiJS](https://pixijs.com) 6. Backgrounds, stills and
character portraits become sprites on a fixed 1920 × 1080 stage that scales to
any screen; blur, brightness and position changes run as GPU filters and
transforms instead of CSS; rain, snow and petals are batched particle layers.
It is the light 2D option: smaller and faster to start than the Three.js
renderer, and a good fit for portrait-based visual novels and phones.

Anything the stage does not draw itself — text UI, video, transitions, and
content it cannot render — falls back to Vega's DOM scene, so a story always
plays completely.

## Install

```sh
pnpm add @haneoka/vega @haneoka/vega-renderer-pixi pixi.js@^6.5.10
```

PixiJS is a peer dependency: you choose its exact version and it is bundled
by your app, not by this package.

## Use it

```ts
import { VegaEngine } from "@haneoka/vega/engine";
import { createPixiRendererPlugin } from "@haneoka/vega-renderer-pixi";

const engine = new VegaEngine({ officialPlugins: [createPixiRendererPlugin()] });
```

The plugin (`haneoka.renderer-pixi`) contributes a render backend with the
id `vega-pixi` and backend name `pixi`. Select it when you have more than one
renderer installed.

## Options

| Option | Meaning | Default |
| --- | --- | --- |
| `referenceWidth`, `referenceHeight` | The stage size story coordinates refer to | 1920 × 1080 |
| `backgroundColor` | Colour behind the stage, as a number | `0x050713` |
| `maxResolution` | Upper limit for the device pixel ratio | 2 |
| `antialias` | WebGL antialiasing | `true` |
| `autoDensity` | Match CSS pixels to device pixels | `true` |
| `profile` | `"vega"`, or `"webgal"` for WebGAL's stage layout | `"vega"` |
| `contributionId`, `backend` | Ids of the render contribution | `vega-pixi`, `pixi` |

Lowering `maxResolution` to 1 is the quickest way to save GPU time on weak
devices.

## What it draws

- **Backgrounds and stills**, fitted to the stage the way the story asks.
- **Static characters** — images given by a model entry's `imageUrl`,
  `portraitUrl` or `source`, or a `model` that is an image file. Live2D and
  Spine characters are drawn by their own character plugins
  ([Cubism](https://github.com/haneoka-gakuen/vega-plugin-cubism),
  [Spine](https://github.com/haneoka-gakuen/vega-plugin-spine)).
- **Per-character and background effects** — blur, brightness and world
  transforms.
- **Weather** — rain, snow and petals.

Textures are shared between scenes and released when the last user is done;
loading stops cleanly when the player seeks or closes, so nothing leaks.

`stage.snapshot` in the editor preview reports the renderer, profile,
reference size, current viewport, visible characters and active effects.

## WebGAL layout

`computeWebGalLayout` reproduces where WebGAL places figures and backgrounds.
The [WebGAL compatibility plugin](https://github.com/haneoka-gakuen/vega-plugin-webgal)
uses this renderer with `profile: "webgal"`.

## License

MPL-2.0. PixiJS is a separately licensed peer dependency and is not bundled.
