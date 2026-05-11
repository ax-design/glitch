import { BaseGlitch } from './glitch/BaseGlitch.js';
import { GlitchValue } from './params/GlitchValue.js';
import { GlitchValueCollection } from './params/GlitchValueCollection.js';
import { JpegAnalyzer } from './core/JpegAnalyzer.js';
import { base64ToBytes } from './core/JpegBytes.js';
import { BufferManager } from './core/BufferManager.js';

export class GlitchCanvas extends HTMLElement {
    static readonly ElementName = 'glitch-canvas';

    private _root = this.attachShadow({ mode: 'open' });
    private _canvas: HTMLCanvasElement;
    private _bufferManager: BufferManager;
    private _glitches: BaseGlitch[] = [];
    private _playing = false;
    private _playbackTimer: number | null = null;
    private _fps = 12;
    private _src = '';
    private _autoplay = false;
    private _imageWidth = 0;
    private _imageHeight = 0;

    static get observedAttributes(): string[] {
        return ['src', 'fps', 'buffer-size', 'autoplay'];
    }

    constructor() {
        super();
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = 'display:block;width:100%;height:100%;image-rendering:pixelated;';
        this._root.innerHTML = '';
        this._root.appendChild(this._canvas);

        const style = document.createElement('style');
        style.textContent = ':host{display:inline-block;}';
        this._root.insertBefore(style, this._canvas);

        this._bufferManager = new BufferManager(4);
    }

    connectedCallback(): void {
        if (this._src) {
            this.load(this._src);
        }
    }

    disconnectedCallback(): void {
        this.pause();
    }

    attributeChangedCallback(name: string, oldVal: string, newVal: string): void {
        if (oldVal === newVal) return;

        switch (name) {
            case 'src':
                this._src = newVal;
                if (this.isConnected) this.load(newVal);
                break;
            case 'fps':
                this._fps = parseInt(newVal, 10) || 12;
                break;
            case 'buffer-size':
                this._bufferManager.bufferSize = parseInt(newVal, 10) || 4;
                if (this._bufferManager.ready) {
                    this._bufferManager.invalidateAll();
                }
                break;
            case 'autoplay':
                this._autoplay = newVal !== null;
                if (this._autoplay && this._bufferManager.ready) {
                    this.play();
                }
                break;
        }
    }

    // --- Attributes ---

    get src(): string {
        return this.getAttribute('src') ?? '';
    }

    set src(val: string) {
        this.setAttribute('src', val);
    }

    get fps(): number {
        return this._fps;
    }

    set fps(val: number) {
        this._fps = val;
        this.setAttribute('fps', String(val));
    }

    get bufferSize(): number {
        return this._bufferManager.bufferSize;
    }

    set bufferSize(val: number) {
        this.setAttribute('buffer-size', String(val));
    }

    get autoplay(): boolean {
        return this.hasAttribute('autoplay');
    }

    set autoplay(val: boolean) {
        if (val) {
            this.setAttribute('autoplay', '');
        } else {
            this.removeAttribute('autoplay');
        }
    }

    // --- Playback ---

    get isPlaying(): boolean {
        return this._playing;
    }

    play(): void {
        if (this._playing) return;
        if (!this._bufferManager.ready) return;
        this._playing = true;
        this._bufferManager.start();
        this._scheduleNextFrame();
    }

    pause(): void {
        if (!this._playing) return;
        this._playing = false;
        this._bufferManager.stop();
        if (this._playbackTimer !== null) {
            clearTimeout(this._playbackTimer);
            this._playbackTimer = null;
        }
    }

    // --- Image Loading ---

    async load(url: string): Promise<void> {
        let response: Response;
        try {
            response = await fetch(url, { mode: 'cors' });
        } catch (err) {
            if (err instanceof TypeError) {
                throw new Error('Network error fetching image: ' + url);
            }
            throw err;
        }

        if (response.type === 'opaque') {
            throw new Error(
                'CORS error: Cannot access image at ' + url +
                '. The server must include Access-Control-Allow-Origin headers.',
            );
        }

        if (!response.ok) {
            throw new Error(
                'HTTP ' + response.status + ' loading image: ' + url,
            );
        }

        const blob = await response.blob();
        await this._loadFromBlob(blob);
    }

    cloneFrom(element: HTMLCanvasElement | HTMLImageElement | HTMLPictureElement): void {
        if (element instanceof HTMLCanvasElement) {
            const base64 = element.toDataURL('image/jpeg', 0.95);
            const bytes = base64ToBytes(base64);
            this._setSource(bytes, element.width, element.height);
        } else if (element instanceof HTMLImageElement) {
            this._drawImageToSource(element);
        } else if (element instanceof HTMLPictureElement) {
            const img = element.querySelector('img');
            if (img) {
                this._drawImageToSource(img);
            }
        }
    }

    private _drawImageToSource(img: HTMLImageElement): void {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.naturalWidth || img.width;
        tempCanvas.height = img.naturalHeight || img.height;
        const ctx = tempCanvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const base64 = tempCanvas.toDataURL('image/jpeg', 0.95);
        const bytes = base64ToBytes(base64);
        this._setSource(bytes, tempCanvas.width, tempCanvas.height);
    }

    private async _loadFromBlob(blob: Blob): Promise<void> {
        const img = new Image();
        const url = URL.createObjectURL(blob);

        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Failed to decode image from blob'));
            img.src = url;
        });
        URL.revokeObjectURL(url);

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.naturalWidth;
        tempCanvas.height = img.naturalHeight;
        const ctx = tempCanvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);

        const base64 = tempCanvas.toDataURL('image/jpeg', 0.95);
        const bytes = base64ToBytes(base64);
        this._setSource(bytes, tempCanvas.width, tempCanvas.height);
    }

    private _setSource(bytes: Uint8Array, width: number, height: number): void {
        const analysis = JpegAnalyzer.analyze(bytes);
        this._imageWidth = width;
        this._imageHeight = height;

        this._canvas.width = width;
        this._canvas.height = height;

        this._bufferManager.setSource(bytes, analysis, width, height);
        this._bufferManager.setGlitches(this._glitches);
        this._bufferManager.invalidateAll().then(() => {
            // Draw the first buffer onto the main canvas immediately
            const frame = this._bufferManager.pickFrame();
            if (frame) {
                const ctx = this._canvas.getContext('2d')!;
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(frame.canvas, 0, 0);
            }

            if (this._autoplay) {
                this.play();
            }
        });
    }

    // --- Glitch Management ---

    addGlitch(glitch: BaseGlitch): void {
        this._glitches.push(glitch);
        this._bufferManager.setGlitches(this._glitches);
    }

    removeGlitch(glitch: BaseGlitch): void {
        const idx = this._glitches.indexOf(glitch);
        if (idx >= 0) {
            this._glitches.splice(idx, 1);
            this._bufferManager.setGlitches(this._glitches);
        }
    }

    setGlitches(glitches: BaseGlitch[]): void {
        this._glitches = [...glitches];
        this._bufferManager.setGlitches(this._glitches);
    }

    get glitches(): ReadonlyArray<BaseGlitch> {
        return this._glitches;
    }

    // --- Randomization ---

    randomize(): void {
        for (const glitch of this._glitches) {
            if ('val' in glitch) {
                const val = (glitch as any).val;
                if (val instanceof GlitchValueCollection) {
                    val.randomize();
                } else if (val instanceof GlitchValue) {
                    val.randomize();
                }
            }
        }
        this.requestRender();
    }

    requestRender(): void {
        if (!this._bufferManager.ready) return;
        this._bufferManager.invalidateAll();
    }

    // --- Internal ---

    private _scheduleNextFrame(): void {
        if (!this._playing) return;

        const frame = this._bufferManager.pickFrame();
        if (frame) {
            const ctx = this._canvas.getContext('2d')!;
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            ctx.drawImage(frame.canvas, 0, 0);
        }

        this._playbackTimer = window.setTimeout(
            () => this._scheduleNextFrame(),
            1000 / this._fps,
        );
    }
}
