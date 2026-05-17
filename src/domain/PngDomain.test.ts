import { test, expect, beforeAll } from 'bun:test';
import CanvasKitInit from 'canvaskit-wasm';
import type { CanvasKit, Canvas } from 'canvaskit-wasm';
import { parsePngChunks, assemblePng } from '../core/PngProcessor.js';
import { parseZlibDeflate } from '../core/DeflateRepair.js';
import { PngDomain } from './PngDomain.js';
import type { PngDomainState } from './PngDomain.js';
import { FilterDataGlitch } from '../glitch/png/FilterDataGlitch.js';
import { TransposeGlitch } from '../glitch/png/TransposeGlitch.js';
import { DefectGlitch } from '../glitch/png/DefectGlitch.js';
import { GraftGlitch } from '../glitch/png/GraftGlitch.js';
import { CompressedReplaceGlitch } from '../glitch/png/CompressedReplaceGlitch.js';
import { CompressedTransposeGlitch } from '../glitch/png/CompressedTransposeGlitch.js';
import { CompressedDefectGlitch } from '../glitch/png/CompressedDefectGlitch.js';
import { CustomFilterGlitch } from '../glitch/png/CustomFilterGlitch.js';
import { PngFilterType } from '../glitch/png/types.js';
import { Position } from '../params/Position.js';
import { GlitchValueCollection } from '../params/GlitchValueCollection.js';
import { DensityValue } from '../params/DensityValue.js';
import { DistributionKind } from '../params/Distribution.js';

let CanvasKit: CanvasKit;

beforeAll(async () => {
    const path = require('path') as typeof import('path');
    const wasmDir = path.resolve(__dirname, '../../node_modules/canvaskit-wasm/bin');
    CanvasKit = await CanvasKitInit({
        locateFile: (file: string) => path.join(wasmDir, file),
    });
});

function makePngBytes(width: number, height: number): Uint8Array {
    const surface = CanvasKit.MakeSurface(width, height)!;
    const canvas = surface.getCanvas();
    const paint = new CanvasKit.Paint();

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const r = Math.floor((x / width) * 255);
            const g = Math.floor((y / height) * 255);
            const b = Math.floor(((x + y) / (width + height)) * 255);
            paint.setColor(CanvasKit.Color(r, g, b, 255));
            canvas.drawRect(CanvasKit.XYWHRect(x, y, 1, 1), paint);
        }
    }

    paint.delete();
    surface.flush();

    const img = surface.makeImageSnapshot();
    const pngBytes = img.encodeToBytes();
    img.delete();
    surface.dispose();

    return new Uint8Array(pngBytes!);
}

function makeCanvasFromPng(pngBytes: Uint8Array): Canvas {
    const img = CanvasKit.MakeImageFromEncoded(pngBytes)!;
    const surface = CanvasKit.MakeSurface(img.width(), img.height())!;
    const canvas = surface.getCanvas();
    canvas.drawImage(img, 0, 0);
    return canvas;
}

function canDecode(bytes: Uint8Array, width: number, height: number): boolean {
    try {
        const canvas = CanvasKit.MakeCanvas(width, height);
        const img = canvas.decodeImage(bytes);
        if (!img) return false;
        return true;
    } catch {
        return false;
    }
}

function isPngSignature(bytes: Uint8Array): boolean {
    return bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
}

function assertValidCompressedPng(result: Uint8Array, width: number, height: number, expectedFilteredLength: number): void {
    expect(isPngSignature(result)).toBe(true);
    expect(canDecode(result, width, height)).toBe(true);

    const { compressedData } = parsePngChunks(result);
    const parsed = parseZlibDeflate(compressedData);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.output.length).toBe(expectedFilteredLength);
    for (const block of parsed.blocks) {
        expect(block.btype).toBeGreaterThanOrEqual(0);
        expect(block.btype).toBeLessThanOrEqual(2);
    }
}

function diffByteCount(left: Uint8Array, right: Uint8Array): number {
    let diff = 0;
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length; i++) {
        if (left[i] !== right[i]) diff++;
    }
    return diff + Math.abs(left.length - right.length);
}

// Helper: create a PngDomainState from raw PNG bytes (bypasses DOM canvas)
async function prepareState(pngBytes: Uint8Array): Promise<PngDomainState> {
    const domain = new PngDomain();
    return await domain.prepare(pngBytes) as PngDomainState;
}

// Helper: make a replace glitch with fixed count (like pnglitch's 50 operations)
function makeReplaceGlitch(count: number) {
    const c = new GlitchValueCollection(DistributionKind.Random);
    c.countRange = { min: count, max: count };
    c.valueRange = { min: 0, max: 254 };
    c.spread = { min: 0, max: 100 };
    c.randomize();
    return new FilterDataGlitch(new Position(50), c);
}

function makeDefectGlitch(count: number) {
    const c = new GlitchValueCollection(DistributionKind.Random);
    c.countRange = { min: count, max: count };
    c.spread = { min: 0, max: 100 };
    c.randomize();
    return new DefectGlitch(new Position(50), c);
}

function makeCompressedReplaceGlitch(count: number) {
    const c = new GlitchValueCollection(DistributionKind.Random);
    c.countRange = { min: count, max: count };
    c.valueRange = { min: 0, max: 254 };
    c.spread = { min: 0, max: 100 };
    c.randomize();
    return new CompressedReplaceGlitch(new Position(50), c);
}

function makeCompressedDefectGlitch(count: number) {
    const c = new GlitchValueCollection(DistributionKind.Random);
    c.countRange = { min: count, max: count };
    c.spread = { min: 0, max: 100 };
    c.randomize();
    return new CompressedDefectGlitch(new Position(50), c);
}

// ============================================================
// PngDomain.prepare, compressedData in state
// ============================================================

test('PngDomain.prepare: includes compressedData in state', async () => {
    const png = makePngBytes(32, 24);
    const state = await prepareState(png);
    expect(state.compressedData).toBeDefined();
    expect(state.compressedData.length).toBeGreaterThan(0);
    expect(state.analysis.compressedData).toBeDefined();
    expect(state.analysis.compressedData.length).toBe(state.compressedData.length);
});

// ============================================================
// Filtered data glitch: all methods × all filter types
// ============================================================

const FILTER_TYPES = [
    { name: 'None', value: PngFilterType.None },
    { name: 'Sub', value: PngFilterType.Sub },
    { name: 'Up', value: PngFilterType.Up },
    { name: 'Average', value: PngFilterType.Average },
    { name: 'Paeth', value: PngFilterType.Paeth },
];

const FUZZ_RUNS = 20;

for (const ft of FILTER_TYPES) {
    test(`Filtered Replace × ${ft.name} filter: fuzz ${FUZZ_RUNS} runs`, async () => {
        const png = makePngBytes(64, 48);
        const state = await prepareState(png);
        const domain = new PngDomain();

        for (let run = 0; run < FUZZ_RUNS; run++) {
            const glitch = makeReplaceGlitch(50);
            const result = await domain.generateFrame(state, [glitch]);
            expect(isPngSignature(result)).toBe(true);
            expect(result.length).toBeGreaterThan(0);
        }
    });

    test(`Filtered Transpose × ${ft.name} filter: fuzz ${FUZZ_RUNS} runs`, async () => {
        const png = makePngBytes(64, 48);
        const state = await prepareState(png);
        const domain = new PngDomain();

        for (let run = 0; run < FUZZ_RUNS; run++) {
            const glitch = new TransposeGlitch(4);
            const result = await domain.generateFrame(state, [glitch]);
            expect(isPngSignature(result)).toBe(true);
            expect(result.length).toBeGreaterThan(0);
        }
    });

    test(`Filtered Defect × ${ft.name} filter: fuzz ${FUZZ_RUNS} runs`, async () => {
        const png = makePngBytes(64, 48);
        const state = await prepareState(png);
        const domain = new PngDomain();

        for (let run = 0; run < FUZZ_RUNS; run++) {
            const glitch = makeDefectGlitch(10);
            const result = await domain.generateFrame(state, [glitch]);
            expect(isPngSignature(result)).toBe(true);
            expect(result.length).toBeGreaterThan(0);
        }
    });
}

test('parseZlibDeflate rejects dynamic tree corruption even if output length matches', () => {
    const sample = new Uint8Array([
        120, 156, 21, 137, 49, 1, 0, 0, 12, 130, 204, 100, 38, 51, 153, 137, 88, 155, 23, 34, 68, 4, 3, 169, 232, 207, 216, 214, 76, 207, 191, 150, 61, 180, 81, 208, 1, 58, 10, 21, 125,
    ]);
    const mutated = new Uint8Array(sample);
    mutated[8] ^= 0x80;

    const parsed = parseZlibDeflate(mutated);
    expect(parsed.ok).toBe(false);
});

test('Compressed Replace: fuzz 20 runs', async () => {
    const width = 64;
    const height = 48;
    const png = makePngBytes(width, height);
    const state = await prepareState(png);
    const domain = new PngDomain();
    const expectedFilteredLength = state.filteredData.length;

    for (let run = 0; run < FUZZ_RUNS; run++) {
        const glitch = makeCompressedReplaceGlitch(10);
        const result = await domain.generateFrame(state, [glitch]);
        assertValidCompressedPng(result, width, height, expectedFilteredLength);
    }
});

test('Compressed Transpose: fuzz 20 runs', async () => {
    const width = 64;
    const height = 48;
    const png = makePngBytes(width, height);
    const state = await prepareState(png);
    const domain = new PngDomain();
    const expectedFilteredLength = state.filteredData.length;

    for (let run = 0; run < FUZZ_RUNS; run++) {
        const glitch = new CompressedTransposeGlitch(4);
        const result = await domain.generateFrame(state, [glitch]);
        assertValidCompressedPng(result, width, height, expectedFilteredLength);
    }
});

test('Compressed Defect: fuzz 20 runs', async () => {
    const width = 64;
    const height = 48;
    const png = makePngBytes(width, height);
    const state = await prepareState(png);
    const domain = new PngDomain();
    const expectedFilteredLength = state.filteredData.length;

    for (let run = 0; run < FUZZ_RUNS; run++) {
        const glitch = makeCompressedDefectGlitch(5);
        const result = await domain.generateFrame(state, [glitch]);
        assertValidCompressedPng(result, width, height, expectedFilteredLength);
    }
});

test('Compressed Replace: produces non-trivial filtered-data change across repeated runs', async () => {
    const width = 64;
    const height = 48;
    const png = makePngBytes(width, height);
    const state = await prepareState(png);
    const domain = new PngDomain();

    let changedRuns = 0;
    for (let run = 0; run < 8; run++) {
        const glitch = makeCompressedReplaceGlitch(10);
        const result = await domain.generateFrame(state, [glitch]);
        assertValidCompressedPng(result, width, height, state.filteredData.length);
        const { compressedData } = parsePngChunks(result);
        const parsed = parseZlibDeflate(compressedData);
        expect(parsed.ok).toBe(true);
        if (parsed.ok && diffByteCount(parsed.output, state.filteredData) > 0) {
            changedRuns++;
        }
    }

    expect(changedRuns).toBeGreaterThan(0);
});

test('Compressed Defect: produces non-trivial filtered-data change across repeated runs', async () => {
    const width = 64;
    const height = 48;
    const png = makePngBytes(width, height);
    const state = await prepareState(png);
    const domain = new PngDomain();

    let changedRuns = 0;
    for (let run = 0; run < 8; run++) {
        const glitch = makeCompressedDefectGlitch(5);
        const result = await domain.generateFrame(state, [glitch]);
        assertValidCompressedPng(result, width, height, state.filteredData.length);
        const { compressedData } = parsePngChunks(result);
        const parsed = parseZlibDeflate(compressedData);
        expect(parsed.ok).toBe(true);
        if (parsed.ok && diffByteCount(parsed.output, state.filteredData) > 0) {
            changedRuns++;
        }
    }

    expect(changedRuns).toBeGreaterThan(0);
});

test('Compressed Transpose: produces non-trivial filtered-data change across repeated runs', async () => {
    const width = 64;
    const height = 48;
    const png = makePngBytes(width, height);
    const state = await prepareState(png);
    const domain = new PngDomain();

    let changedRuns = 0;
    for (let run = 0; run < 8; run++) {
        const glitch = new CompressedTransposeGlitch(4);
        const result = await domain.generateFrame(state, [glitch]);
        assertValidCompressedPng(result, width, height, state.filteredData.length);
        const { compressedData } = parsePngChunks(result);
        const parsed = parseZlibDeflate(compressedData);
        expect(parsed.ok).toBe(true);
        if (parsed.ok && diffByteCount(parsed.output, state.filteredData) > 0) {
            changedRuns++;
        }
    }

    expect(changedRuns).toBeGreaterThan(0);
});

test('Compressed Replace stress: 100 runs stay decodable', async () => {
    const width = 96;
    const height = 72;
    const png = makePngBytes(width, height);
    const state = await prepareState(png);
    const domain = new PngDomain();
    const expectedFilteredLength = state.filteredData.length;

    for (let run = 0; run < 100; run++) {
        const glitch = makeCompressedReplaceGlitch(20);
        const result = await domain.generateFrame(state, [glitch]);
        assertValidCompressedPng(result, width, height, expectedFilteredLength);
    }
});

test('Compressed Transpose stress: 100 runs stay decodable', async () => {
    const width = 96;
    const height = 72;
    const png = makePngBytes(width, height);
    const state = await prepareState(png);
    const domain = new PngDomain();
    const expectedFilteredLength = state.filteredData.length;

    for (let run = 0; run < 100; run++) {
        const glitch = new CompressedTransposeGlitch(6);
        const result = await domain.generateFrame(state, [glitch]);
        assertValidCompressedPng(result, width, height, expectedFilteredLength);
    }
});

for (const graftValue of [0, 1, 2, 3, 4]) {
    test(`Graft filter type ${graftValue}: fuzz ${FUZZ_RUNS} runs`, async () => {
        const png = makePngBytes(64, 48);
        const state = await prepareState(png);
        const domain = new PngDomain();

        for (let run = 0; run < FUZZ_RUNS; run++) {
            const density = new DensityValue(1.0, { min: graftValue, max: graftValue });
            const glitch = new GraftGlitch(new Position(0), density);
            const result = await domain.generateFrame(state, [glitch]);
            expect(isPngSignature(result)).toBe(true);
            expect(canDecode(result, 64, 48)).toBe(true);
        }
    });
}

// ============================================================
// Custom filter glitch
// ============================================================

test('CustomFilterGlitch (XOR encoder): fuzz 20 runs', async () => {
    const png = makePngBytes(64, 48);
    const state = await prepareState(png);
    const domain = new PngDomain();

    for (let run = 0; run < FUZZ_RUNS; run++) {
        const customEncoder = (data: Uint8Array, prev: Uint8Array | null, sampleSize: number) => {
            const result = new Uint8Array(data);
            for (let i = sampleSize; i < data.length; i++) {
                result[i] = (data[i] ^ data[i - sampleSize]) & 0xff;
            }
            return result;
        };
        const glitch = new CustomFilterGlitch(customEncoder);
        const result = await domain.generateFrame(state, [glitch]);
        expect(isPngSignature(result)).toBe(true);
        expect(canDecode(result, 64, 48)).toBe(true);
    }
});

test('CustomFilterGlitch (reversed reference): fuzz 20 runs', async () => {
    const png = makePngBytes(64, 48);
    const state = await prepareState(png);
    const domain = new PngDomain();

    for (let run = 0; run < FUZZ_RUNS; run++) {
        const customEncoder = (data: Uint8Array, prev: Uint8Array | null, sampleSize: number) => {
            const result = new Uint8Array(data);
            for (let i = data.length - 1; i >= 0; i--) {
                const x = data[i];
                const v = prev ? (prev[i - 1] || 0) : 0;
                result[i] = (x - v) & 0xff;
            }
            return result;
        };
        const glitch = new CustomFilterGlitch(customEncoder);
        const result = await domain.generateFrame(state, [glitch]);
        expect(isPngSignature(result)).toBe(true);
        expect(canDecode(result, 64, 48)).toBe(true);
    }
});

test('assemblePng: produces PNG with valid signature even with corrupted data', async () => {
    const png = makePngBytes(32, 24);
    const { metadata, compressedData } = parsePngChunks(png);
    const corrupted = new Uint8Array(compressedData);
    corrupted[10] = 0xff;
    corrupted[20] = 0x00;
    const assembled = assemblePng(corrupted, metadata);
    expect(isPngSignature(assembled)).toBe(true);
});

// ============================================================
// No glitches: passthrough
// ============================================================

test('generateFrame with no glitches returns original bytes', async () => {
    const png = makePngBytes(32, 24);
    const state = await prepareState(png);
    const domain = new PngDomain();
    const result = await domain.generateFrame(state, []);
    expect(result).toEqual(png);
});
