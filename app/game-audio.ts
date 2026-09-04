/** Tiny synthesized stone sounds: no audio downloads and no playback before a gesture. */
export class StoneAudio {
  private context?: AudioContext;
  enabled = false;

  play(kind: "pickup" | "deposit" | "monument") {
    if (!this.enabled) return;
    try {
      this.context ??= new AudioContext();
      const context = this.context;
      if (context.state === "suspended") void context.resume().catch(() => undefined);
      const frequencies = kind === "monument" ? [392, 494, 587, 784] : kind === "deposit" ? [190, 95] : [340];
      for (const [index, frequency] of frequencies.entries()) {
        const oscillator = context.createOscillator();
        const volume = context.createGain();
        const start = context.currentTime + index * 0.075;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.6, start + 0.2);
        volume.gain.setValueAtTime(0.0001, start);
        volume.gain.exponentialRampToValueAtTime(0.085, start + 0.008);
        volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
        oscillator.connect(volume).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.36);
      }
    } catch { /* Sound is optional on browsers without Web Audio. */ }
  }

  dispose() { void this.context?.close().catch(() => undefined); }
}
