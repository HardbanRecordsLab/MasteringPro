/** Apply a static gain to a buffer (returns a new buffer, hard-limited to ±1 so a bad gain can never wrap). */
export function applyGain(buffer: AudioBuffer, gain: number): AudioBuffer {
  if (gain === 1) return buffer;
  const out = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) {
      const v = src[i] * gain;
      dst[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }
  return out;
}
