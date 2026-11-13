export function wavHeader(frames, sampleRate, channels = 1) {
  const bytes = frames * channels * 2;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 0xffffffff - 36) throw new Error('录音超出 WAV 大小限制');
  const data = new ArrayBuffer(44), view = new DataView(data);
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes + 36, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes, true);
  return data;
}
