import type { DomainAnalysis, DomainState, GlitchDomain, FrameResult } from './types.js';
import type { BaseGlitch } from '../glitch/BaseGlitch.js';
import { base64ToBytes } from '../core/JpegBytes.js';
import {
    parsePngChunks,
    inflateCompressed,
    computeScanlines,
    reencodeWithFilter,
    reencodeWithCustomFilter,
    rebuildPng,
    assemblePng,
    buildFilteredDataPool,
    buildFilterTypePool,
    unfilterToRgba,
} from '../core/PngProcessor.js';
import type { ScanlineInfo, PngMetadata } from '../core/PngProcessor.js';
import {
    parseZlibDeflate,
    repairZlibDeflate,
} from '../core/DeflateRepair.js';
import type {
    DeflateRepairAcceptance,
    ZlibTraceSuccess,
} from '../core/DeflateRepair.js';

export interface PngDomainState extends DomainState {
    filteredData: Uint8Array;
    compressedData: Uint8Array;
    scanlines: ScanlineInfo[];
    metadata: PngMetadata;
    compressedTrace: ZlibTraceSuccess;
}

const DEFAULT_MAX_DIMENSION = 1024;

export class PngDomain implements GlitchDomain {
    readonly id = 'png';
    readonly mimeType = 'image/png';

    async encode(sourceCanvas: HTMLCanvasElement, options?: Record<string, unknown>): Promise<Uint8Array> {
        const maxDim = (options?.maxDimension as number) ?? DEFAULT_MAX_DIMENSION;
        const filterType = options?.filterType as number | undefined;

        let canvas = sourceCanvas;
        if (sourceCanvas.width > maxDim || sourceCanvas.height > maxDim) {
            canvas = this._scaleDown(sourceCanvas, maxDim);
        }

        const base64 = canvas.toDataURL('image/png');
        let bytes = base64ToBytes(base64);

        if (filterType !== undefined) {
            bytes = await this._reencodeWithForcedFilter(bytes, filterType);
        }

        return bytes;
    }

    async prepare(bytes: Uint8Array): Promise<PngDomainState> {
        const { metadata, compressedData } = parsePngChunks(bytes);
        const filteredData = await inflateCompressed(compressedData);
        const scanlines = computeScanlines(filteredData, metadata);
        const analysis = this._buildAnalysis(filteredData, scanlines, compressedData);
        const compressedTrace = parseZlibDeflate(compressedData);

        if (!compressedTrace.ok) {
            throw new Error(`Original PNG compressed data failed custom Deflate parse: ${compressedTrace.error.message}`);
        }

        if (compressedTrace.output.length !== filteredData.length) {
            throw new Error('Custom Deflate parser output length mismatch');
        }
        for (let i = 0; i < filteredData.length; i++) {
            if (compressedTrace.output[i] !== filteredData[i]) {
                throw new Error(`Custom Deflate parser output mismatch at byte ${i}`);
            }
        }

        return { originalBytes: bytes, analysis, filteredData, compressedData, scanlines, metadata, compressedTrace };
    }

    async generateFrame(state: DomainState, glitches: BaseGlitch[]): Promise<Uint8Array | FrameResult> {
        const pngState = state as PngDomainState;

        if (glitches.length === 0) {
            return new Uint8Array(pngState.originalBytes);
        }

        const compressedGlitches: BaseGlitch[] = [];
        const filteredGlitches: BaseGlitch[] = [];
        let customFilterGlitch: import('../glitch/png/CustomFilterGlitch.js').CustomFilterGlitch | null = null;

        for (const glitch of glitches) {
            if (glitch.targetPool === 'compressedData') {
                compressedGlitches.push(glitch);
            } else if (glitch.type === 'customFilter') {
                customFilterGlitch = glitch as import('../glitch/png/CustomFilterGlitch.js').CustomFilterGlitch;
            } else {
                filteredGlitches.push(glitch);
            }
        }

        if (compressedGlitches.length > 0) {
            return this._applyCompressedGlitches(pngState, compressedGlitches, filteredGlitches, customFilterGlitch);
        }

        if (customFilterGlitch) {
            return this._applyCustomFilterGlitch(pngState, customFilterGlitch, filteredGlitches);
        }

        if (filteredGlitches.length > 0) {
            return this._applyFilteredGlitches(pngState, filteredGlitches);
        }

        return new Uint8Array(pngState.originalBytes);
    }

    private _scaleDown(source: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
        const scale = maxDim / Math.max(source.width, source.height);
        const w = Math.round(source.width * scale);
        const h = Math.round(source.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(source, 0, 0, w, h);
        return canvas;
    }

    private async _reencodeWithForcedFilter(bytes: Uint8Array, targetFilterType: number): Promise<Uint8Array> {
        const { metadata, compressedData } = parsePngChunks(bytes);
        const filteredData = await inflateCompressed(compressedData);
        const scanlines = computeScanlines(filteredData, metadata);
        const reencoded = reencodeWithFilter(filteredData, scanlines, metadata, targetFilterType);
        return rebuildPng(reencoded, metadata);
    }

    private _buildAnalysis(filteredData: Uint8Array, scanlines: ScanlineInfo[], compressedData: Uint8Array): DomainAnalysis {
        return {
            filteredData: buildFilteredDataPool(filteredData, scanlines),
            filterTypes: buildFilterTypePool(scanlines),
            compressedData: { length: compressedData.length, resolve: (i: number) => i },
        };
    }

    private async _applyCompressedGlitches(
        pngState: PngDomainState,
        compressedGlitches: BaseGlitch[],
        filteredGlitches: BaseGlitch[],
        customFilterGlitch: import('../glitch/png/CustomFilterGlitch.js').CustomFilterGlitch | null,
    ): Promise<Uint8Array | FrameResult> {
        let candidateCompressed = new Uint8Array(pngState.compressedData);
        const compressedPool = pngState.analysis.compressedData;

        for (const glitch of compressedGlitches) {
            const result = glitch.apply(candidateCompressed, compressedPool);
            if (result instanceof Uint8Array) {
                candidateCompressed = new Uint8Array(result);
            }
        }

        const candidateParsed = parseZlibDeflate(candidateCompressed);
        let baseFilteredData = new Uint8Array(pngState.filteredData);
        let repairedCompressedData: Uint8Array | null = null;
        let hasCompressedEffect = false;

        const directStabilized = this._stabilizeCompressedFilteredData(candidateParsed.output, pngState);
        if (directStabilized.changedBytes > 0) {
            baseFilteredData = new Uint8Array(directStabilized.filteredData);
            hasCompressedEffect = true;
        } else {
            const repaired = repairZlibDeflate(
                candidateCompressed,
                pngState.compressedTrace,
                (output) => this._acceptCompressedRepairOutput(output, pngState),
            );

            if (repaired) {
                const stabilized = this._stabilizeCompressedFilteredData(repaired.filteredData, pngState);
                baseFilteredData = new Uint8Array(stabilized.filteredData);
                hasCompressedEffect = stabilized.changedBytes > 0;
                if (stabilized.patchedFilterBytes === 0) {
                    repairedCompressedData = new Uint8Array(repaired.compressedData);
                }
            }
        }

        if (customFilterGlitch) {
            let reencoded = reencodeWithCustomFilter(
                baseFilteredData,
                pngState.scanlines,
                pngState.metadata,
                customFilterGlitch.encoder,
                customFilterGlitch.scanlineRange,
            );
            reencoded = this._applyFilteredGlitchesToBytes(pngState, reencoded, filteredGlitches);
            return this._finalizeFrame(pngState, reencoded);
        }

        if (filteredGlitches.length > 0) {
            const filteredData = this._applyFilteredGlitchesToBytes(pngState, new Uint8Array(baseFilteredData), filteredGlitches);
            return this._finalizeFrame(pngState, filteredData);
        }

        if (repairedCompressedData) {
            return assemblePng(repairedCompressedData, pngState.metadata);
        }

        if (hasCompressedEffect) {
            return this._finalizeFrame(pngState, baseFilteredData);
        }

        return new Uint8Array(pngState.originalBytes);
    }

    private _applyFilteredGlitchesToBytes(
        pngState: PngDomainState,
        filteredData: Uint8Array,
        glitches: BaseGlitch[],
    ): Uint8Array {
        let next = filteredData;
        for (const glitch of glitches) {
            const pool = pngState.analysis[glitch.targetPool];
            if (!pool) continue;
            const result = glitch.apply(next, pool);
            if (result instanceof Uint8Array) {
                next = new Uint8Array(result);
            }
        }
        return next;
    }

    private _acceptCompressedRepairOutput(filteredData: Uint8Array, pngState: PngDomainState): DeflateRepairAcceptance {
        const expectedLength = pngState.filteredData.length;
        if (filteredData.length !== expectedLength) {
            return { ok: false, anchorOutputOffset: Math.min(filteredData.length, expectedLength) };
        }

        const scanlines = computeScanlines(filteredData, pngState.metadata);
        if (scanlines.length !== pngState.scanlines.length) {
            return { ok: false, anchorOutputOffset: 0 };
        }

        const lastScanline = scanlines[scanlines.length - 1];
        const coveredEnd = lastScanline.dataStart + lastScanline.dataLength;
        if (coveredEnd !== filteredData.length) {
            return { ok: false, anchorOutputOffset: coveredEnd };
        }

        return { ok: true };
    }

    private _stabilizeCompressedFilteredData(
        filteredData: Uint8Array,
        pngState: PngDomainState,
    ): { filteredData: Uint8Array; patchedFilterBytes: number; changedBytes: number } {
        const next = new Uint8Array(pngState.filteredData);
        const copyLength = Math.min(filteredData.length, next.length);
        next.set(filteredData.subarray(0, copyLength));

        const scanlines = computeScanlines(next, pngState.metadata);
        let patchedFilterBytes = 0;
        for (const scanline of scanlines) {
            const offset = scanline.filterTypeOffset;
            if (next[offset] > 4) {
                next[offset] = pngState.filteredData[offset];
                patchedFilterBytes++;
            }
        }

        let changedBytes = 0;
        for (let i = 0; i < next.length; i++) {
            if (next[i] !== pngState.filteredData[i]) {
                changedBytes++;
            }
        }

        return { filteredData: next, patchedFilterBytes, changedBytes };
    }

    private async _applyFilteredGlitches(pngState: PngDomainState, glitches: BaseGlitch[]): Promise<Uint8Array | FrameResult> {
        const filteredData = this._applyFilteredGlitchesToBytes(pngState, new Uint8Array(pngState.filteredData), glitches);
        return this._finalizeFrame(pngState, filteredData);
    }

    private async _finalizeFrame(pngState: PngDomainState, filteredData: Uint8Array): Promise<Uint8Array | FrameResult> {
        // Fast path: if not interlaced, unfilter directly and return bitmap
        if (!pngState.metadata.interlaced && typeof createImageBitmap !== 'undefined') {
            const rgba = unfilterToRgba(filteredData, pngState.scanlines, pngState.metadata);
            const imageData = new ImageData(pngState.metadata.width, pngState.metadata.height);
            imageData.data.set(rgba);
            const bitmap = await createImageBitmap(imageData);
            const bytes = await rebuildPng(filteredData, pngState.metadata);
            return { bytes, bitmap };
        }

        const bytes = await rebuildPng(filteredData, pngState.metadata);
        return bytes;
    }

    private async _applyCustomFilterGlitch(
        pngState: PngDomainState,
        customGlitch: import('../glitch/png/CustomFilterGlitch.js').CustomFilterGlitch,
        otherGlitches: BaseGlitch[],
    ): Promise<Uint8Array | FrameResult> {
        let reencoded = reencodeWithCustomFilter(
            new Uint8Array(pngState.filteredData),
            pngState.scanlines,
            pngState.metadata,
            customGlitch.encoder,
            customGlitch.scanlineRange,
        );
        reencoded = this._applyFilteredGlitchesToBytes(pngState, reencoded, otherGlitches.filter((glitch) => glitch !== customGlitch));
        return this._finalizeFrame(pngState, reencoded);
    }
}
