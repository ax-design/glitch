import type { DomainAnalysis, DomainState, GlitchDomain } from './types.js';
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
} from '../core/PngProcessor.js';
import type { ScanlineInfo, PngMetadata } from '../core/PngProcessor.js';

export interface PngDomainState extends DomainState {
    filteredData: Uint8Array;
    compressedData: Uint8Array;
    scanlines: ScanlineInfo[];
    metadata: PngMetadata;
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

        return { originalBytes: bytes, analysis, filteredData, compressedData, scanlines, metadata };
    }

    async generateFrame(state: DomainState, glitches: BaseGlitch[]): Promise<Uint8Array> {
        const pngState = state as PngDomainState;

        if (glitches.length === 0) {
            return new Uint8Array(pngState.originalBytes);
        }

        // Split glitches by target
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

        // Compressed data path: glitch the raw Deflate stream, then assemble directly
        if (compressedGlitches.length > 0) {
            return this._applyCompressedGlitches(pngState, compressedGlitches, filteredGlitches, customFilterGlitch);
        }

        // Custom filter path
        if (customFilterGlitch) {
            return this._applyCustomFilterGlitch(pngState, customFilterGlitch, filteredGlitches);
        }

        // Filtered data path
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
    ): Promise<Uint8Array> {
        // Corrupt the compressed (Deflate) stream directly
        const compressedData = new Uint8Array(pngState.compressedData);
        const compressedPool = pngState.analysis.compressedData;

        for (const glitch of compressedGlitches) {
            glitch.apply(compressedData, compressedPool);
        }

        // Try to inflate the corrupted data for filtered glitch path
        try {
            const filteredData = await inflateCompressed(compressedData);
            const scanlines = computeScanlines(filteredData, pngState.metadata);

            if (customFilterGlitch) {
                const reencoded = reencodeWithCustomFilter(
                    filteredData, scanlines, pngState.metadata,
                    customFilterGlitch.encoder, customFilterGlitch.scanlineRange,
                );
                for (const glitch of filteredGlitches) {
                    const pool = pngState.analysis[glitch.targetPool];
                    if (pool) glitch.apply(reencoded, pool);
                }
                return rebuildPng(reencoded, pngState.metadata);
            }

            for (const glitch of filteredGlitches) {
                const pool = pngState.analysis[glitch.targetPool];
                if (pool) glitch.apply(filteredData, pool);
            }
            return rebuildPng(filteredData, pngState.metadata);
        } catch {
            // Inflation failed — assemble PNG with corrupted compressed data directly.
            // Browser will attempt partial decode.
            return assemblePng(compressedData, pngState.metadata);
        }
    }

    private async _applyFilteredGlitches(pngState: PngDomainState, glitches: BaseGlitch[]): Promise<Uint8Array> {
        const filteredData = new Uint8Array(pngState.filteredData);

        for (const glitch of glitches) {
            const pool = pngState.analysis[glitch.targetPool];
            if (pool) glitch.apply(filteredData, pool);
        }

        return rebuildPng(filteredData, pngState.metadata);
    }

    private async _applyCustomFilterGlitch(
        pngState: PngDomainState,
        customGlitch: import('../glitch/png/CustomFilterGlitch.js').CustomFilterGlitch,
        otherGlitches: BaseGlitch[],
    ): Promise<Uint8Array> {
        const filteredData = new Uint8Array(pngState.filteredData);
        const reencoded = reencodeWithCustomFilter(
            filteredData,
            pngState.scanlines,
            pngState.metadata,
            customGlitch.encoder,
            customGlitch.scanlineRange,
        );

        for (const glitch of otherGlitches) {
            if (glitch === customGlitch) continue;
            const pool = pngState.analysis[glitch.targetPool];
            if (pool) glitch.apply(reencoded, pool);
        }

        return rebuildPng(reencoded, pngState.metadata);
    }
}
