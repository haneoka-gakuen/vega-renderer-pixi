# `@haneoka/vega-renderer-pixi`

PixiJS 6 renderer for Vega.

- GPU backgrounds, stills, and static characters on a 1920×1080 reference plane
- Per-character and background blur, brightness, and world transforms
- Batched rain, snow, and petals
- Reference-counted, abort-aware texture lifecycles
- Vega DOM fallback for UI, video, transitions, save/seek, and unsupported assets

```sh
pnpm add @haneoka/vega @haneoka/vega-renderer-pixi pixi.js@^6.5.10
```

```ts
import { VegaEngine } from "@haneoka/vega";
import { createPixiRendererPlugin } from "@haneoka/vega-renderer-pixi";

const engine = new VegaEngine({
  plugins: [createPixiRendererPlugin()],
});
```

PixiJS remains a peer dependency, so applications control its version and
bundle. Dynamic Cubism and Spine models stay behind Vega character-provider
plugins; this renderer does not ship those runtimes or model data.

## License

MPL-2.0. PixiJS is a separately licensed peer dependency and is not bundled in
the published package.
