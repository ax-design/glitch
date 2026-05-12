import { BaseGlitch } from '../BaseGlitch.js';

export enum PngFilterType {
    None = 0,
    Sub = 1,
    Up = 2,
    Average = 3,
    Paeth = 4,
}

export abstract class PngGlitch extends BaseGlitch {
    readonly domain = 'png';
}
