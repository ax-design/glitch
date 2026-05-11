import { GlitchCanvas } from './GlitchCanvas.js';

export function register(): void {
    customElements.define(GlitchCanvas.ElementName, GlitchCanvas);
}
