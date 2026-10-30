export const concatFloat32 = (chunks: readonly Float32Array[]): Float32Array => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

export const stereoPcm16ToMono16k = (pcm: Buffer): Float32Array => {
  const stereoFrames = Math.floor(pcm.length / 4);
  const output = new Float32Array(Math.floor(stereoFrames / 3));
  let outputIndex = 0;
  for (let frame = 0; frame + 2 < stereoFrames; frame += 3) {
    const byteOffset = frame * 4;
    const left = pcm.readInt16LE(byteOffset);
    const right = pcm.readInt16LE(byteOffset + 2);
    output[outputIndex++] = (left + right) / 65_536;
  }
  return outputIndex === output.length ? output : output.slice(0, outputIndex);
};

export const stereoPcm16ToMono24k = (pcm: Buffer): Float32Array => {
  const stereoFrames = Math.floor(pcm.length / 4);
  const output = new Float32Array(Math.floor(stereoFrames / 2));
  let outputIndex = 0;
  for (let frame = 0; frame + 1 < stereoFrames; frame += 2) {
    const byteOffset = frame * 4;
    const left = pcm.readInt16LE(byteOffset);
    const right = pcm.readInt16LE(byteOffset + 2);
    output[outputIndex++] = (left + right) / 65_536;
  }
  return outputIndex === output.length ? output : output.slice(0, outputIndex);
};

export const resampleLinear = (
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array => {
  if (sourceRate <= 0 || targetRate <= 0) {
    throw new Error("Audio sample rates must be positive");
  }
  if (input.length === 0 || sourceRate === targetRate) return input.slice();
  const length = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const before = Math.min(input.length - 1, Math.floor(position));
    const after = Math.min(input.length - 1, before + 1);
    const fraction = position - before;
    output[index] = input[before]! * (1 - fraction) + input[after]! * fraction;
  }
  return output;
};

export const monoFloatToStereoPcm16 = (samples: Float32Array): Buffer => {
  const output = Buffer.allocUnsafe(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    const value = clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
    output.writeInt16LE(value, index * 4);
    output.writeInt16LE(value, index * 4 + 2);
  }
  return output;
};

export const peakAmplitude = (samples: Float32Array): number => {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
};
