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
    rebuildPngFromCompressed,
    buildFilteredDataPool,
    buildFilterTypePool,
    buildCompressedDataPool,
} from '../core/PngProcessor.js';
import type { ScanlineInfo, PngMetadata } from '../core/PngProcessor.js';

export interface PngDomainState extends DomainState {
    filteredData: Uint8Array;
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

        return { originalBytes: bytes, analysis, filteredData, scanlines, metadata };
    }

    async generateFrame(state: DomainState, glitches: BaseGlitch[]): Promise<Uint8Array> {
        const pngState = state as PngDomainState;

        const filteredGlitches: BaseGlitch[] = [];
        const compressedGlitches: BaseGlitch[] = [];
        let customFilterGlitch: import('../glitch/png/CustomFilterGlitch.js').CustomFilterGlitch | null = null;

        for (const glitch of glitches) {
            if (glitch.type === 'customFilter') {
                customFilterGlitch = glitch as import('../glitch/png/CustomFilterGlitch.js').CustomFilterGlitch;
                filteredGlitches.push(glitch);
                continue;
            }

            if ('layer' in glitch) {
                const layer = (glitch as any).layer as string;
                if (layer === 'compressed') {
                    compressedGlitches.push(glitch);
                } else {
                    filteredGlitches.push(glitch);
                }
            } else {
                filteredGlitches.push(glitch);
            }
        }

        if (customFilterGlitch) {
            return this._applyCustomFilterGlitch(pngState, customFilterGlitch, filteredGlitches);
        }

        if (filteredGlitches.length > 0) {
            return this._applyFilteredGlitches(pngState, filteredGlitches);
        }

        if (compressedGlitches.length > 0) {
            return this._applyCompressedGlitches(pngState, compressedGlitches);
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
            compressedData: buildCompressedDataPool(compressedData),
        };
    }

    private async _applyFilteredGlitches(pngState: PngDomainState, glitches: BaseGlitch[]): Promise<Uint8Array> {
        const filteredData = new Uint8Array(pngState.filteredData);

        for (const glitch of glitches) {
            const pool = pngState.analysis[glitch.targetPool];
            if (pool) glitch.apply(filteredData, pool);
        }

        return rebuildPng(filteredData, pngState.metadata);
    }

    private async _applyCompressedGlitches(pngState: PngDomainState, glitches: BaseGlitch[]): Promise<Uint8Array> {
        const { compressedData } = parsePngChunks(pngState.originalBytes);
        const compressed = new Uint8Array(compressedData);

        for (const glitch of glitches) {
            const pool = pngState.analysis[glitch.targetPool];
            if (pool) glitch.apply(compressed, pool);
        }

        return rebuildPngFromCompressed(compressed, pngState.metadata);
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
