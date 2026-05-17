<h1 align="center">
  <img src="https://raw.githubusercontent.com/ax-design/glitch/master/docs/logo.png" alt="glitch">
</h1>

<p align="center">
  Web component for real-time glitch art effects with buffer-based playback. Supports JPEG and PNG glitch domains with per-frame random domain selection.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ax-design/glitch"><img src="https://img.shields.io/npm/v/@ax-design/glitch.svg" alt="npm version"></a>
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT Licence" />
</p>

## Installation

```bash
// with npm
npm install @ax-design/glitch

// with yarn
yarn add @ax-design/glitch
```

and import it:

```javascript
//CommonJS
require('@ax-design/glitch').register();

//ESModule
import { register } from '@ax-design/glitch';
register();
```

## Usage

To add a glitch effect on your web application, you can use the `glitch-canvas` component.
Here's a basic example:

```html
<glitch-canvas src="example.jpg" autoplay></glitch-canvas>
```

## API Usage Detail

### 1. Loading Images

#### `src` attribute

Set `src` to load an image by URL. The image is fetched via `fetch()` and requires CORS headers.

```html
<glitch-canvas src="example.jpg" crossorigin="anonymous" buffer-size="1"> </glitch-canvas>
```

#### `load()` method

Call `load(url)` programmatically. Returns a Promise that rejects on network or CORS errors.

```javascript
glitchCanvas
    .load('example.jpg')
    .then(function () {
        /* ready */
    })
    .catch(function (err) {
        console.error(err);
    });
```

#### `cloneFrom()` with `<img>` or `<canvas>`

Capture from an existing `<img>` or `<canvas>` element:

```javascript
var image = document.getElementById('my-img');
glitchCanvas.cloneFrom(image);
```

### 2. Attributes

- **`fps`**: Playback frame rate. Default is `8`.
- **`buffer-size`**: Number of internal frame buffers. More buffers means smoother variation during playback. Default is `4`.
- **`refresh-on`**: Specify pointer events to trigger `randomize()`. Supports multiple events separated by space (e.g., `"click enter"`).

### 3. Domain Management

Glitch Canvas uses **domains** to manage glitch types. Each domain is an independent instance; you can add multiple PNG or JPEG domains with different settings.

#### Adding a PNG Domain

```javascript
import { PngDomain, PngFilterType, FilterDataGlitch, Position, GlitchValue } from '@ax-design/glitch';

var domain = canvas.addDomain(new PngDomain(), {
    filterType: PngFilterType.Sub,
});

domain.addGlitch(new FilterDataGlitch(new Position(30), new GlitchValue(128)));
```

#### Multi-Domain Playback

Multiple domains can coexist. Each frame randomly selects one domain, producing mixed effects.

```javascript
import { JpegDomain, PngDomain } from '@ax-design/glitch';

var jpeg = canvas.addDomain(new JpegDomain());
var png = canvas.addDomain(new PngDomain());
canvas.play(); // frames alternate randomly between JPEG and PNG effects
```

### 4. Glitch Types

#### JPEG Glitches

- **`WidthGlitch`**: Overwrites the image width byte.
- **`QuantumGlitch`**: Substitutes a byte in the DQT quantization table.
- **`ChaosGlitch`**: Substitutes bytes in the SOS scan data.
- **`HuffmanGlitch`**: Substitutes bytes in the DHT AC Huffman symbol table.
- **`GhostGlitch`**: Copies a block of scan data from a source offset to a target position.

#### PNG Glitches

- **`FilterDataGlitch`**: Replaces bytes in decompressed filtered scanline data.
- **`DefectGlitch`**: Deletes bytes and shifts subsequent data forward.
- **`TransposeGlitch`**: Rearranges byte-level chunks in random order.
- **`GraftGlitch`**: Changes filter type bytes without re-filtering.
- **`CustomFilterGlitch`**: Re-encodes with a custom filter function.

### 5. Randomization Modes

Each glitch has a `randomizeMode` property that controls what gets randomized per frame during playback:

- `'none'`: static, no change
- `'val'`: randomize values
- `'pos'`: randomize position
- `'both'`: randomize both

```javascript
glitch.randomizeMode = 'both';
```

### 6. API Reference

#### GlitchCanvas Methods

- `play()` / `pause()`: Control playback.
- `load(url)`: Load image from URL.
- `cloneFrom(el)`: Capture from image/canvas element.
- `addDomain(domain, options)`: Add a glitch domain.
- `randomize()`: Randomize all parameters and re-render.
- `requestRender()`: Re-render with current parameters.
- `download(filename)`: Export current frame as PNG.

#### Parameter Classes

- `Position(value)`: 0 to 100, normalized position in pool.
- `GlitchValue(value)`: 0 to 254, single byte value.
- `GlitchValueCollection(entries, distribution)`: Multi-value collection.
- `DensityValue(density, valueRange, distribution)`: Auto-generate sites proportional to image size.
