/**
 * Acoustic Coordinated Reset (CR) Neuromodulation audio engine.
 *
 * Implements the stimulation protocol described in:
 *   Tass, Adamchic, Freund, von Stackelberg & Hauptmann (2012),
 *   "Counteracting tinnitus by acoustic coordinated reset neuromodulation",
 *   Restorative Neurology and Neuroscience 30, 137-159.
 *
 * The parameters below reproduce the most efficacious algorithm used in the
 * RESET trial (stimulation group G1), as specified in Section 2.5 and Fig. 1.
 *
 * Protocol points respected (paper references in comments):
 *  1. Four CR tones centered around the patient's tinnitus frequency ft,
 *     with an equal number of tones placed below and above ft (Sec. 2.5).
 *  2. The tones are equidistantly placed on a LOGARITHMIC scale within the
 *     interval [0.5*ft, 2*ft], reflecting the logarithmic tonotopic
 *     organization of the auditory cortex (Sec. 2.5).
 *  3. Cycle repetition rate F = 1.5 Hz (lower delta band) -> cycle = 1/1.5 s
 *     (Sec. 2.5, Fig. 1a).
 *  4. Four tones per cycle, one per equal time slot, played in RANDOM order
 *     each cycle (Sec. 2.5, Fig. 1a; random variation optimizes CR effect).
 *  5. 3:2 ON-OFF pattern: 3 stimulation cycles followed by 2 silent cycles,
 *     repeated periodically (Sec. 2.5, Fig. 1a).
 *  6. Stimulation tones are equally loud and just super-threshold -> all CR
 *     tones share the same amplitude (Sec. 2.5).
 *  7. Each CR tone is a short sinusoidal tone (Fig. 1 caption).
 *  8. Total stimulation duration configurable; default 15 minutes.
 */

// ---------------------------------------------------------------------------
// Protocol constants (from the paper)
// ---------------------------------------------------------------------------

/** Number of CR tones grouped around the tinnitus frequency (G1). */
export const NUM_TONES = 4;

/** Cycle repetition rate F, in Hz (1.5 Hz, lower delta range). */
export const CYCLE_RATE_HZ = 1.5;

/** Duration of one CR cycle, in seconds (= 1 / F). */
export const CYCLE_DURATION_S = 1 / CYCLE_RATE_HZ;

/** 3:2 ON-OFF pattern: 3 stimulation cycles. */
export const ON_CYCLES = 3;

/** 3:2 ON-OFF pattern: 2 silent cycles. */
export const OFF_CYCLES = 2;

/** Lower bound of the stimulation interval as a factor of ft (0.5*ft). */
export const LOWER_FACTOR = 0.5;

/** Upper bound of the stimulation interval as a factor of ft (2*ft). */
export const UPPER_FACTOR = 2;

/** Default total stimulation duration, in seconds (15 minutes). */
export const DEFAULT_DURATION_S = 15 * 60;

/** Allowed tinnitus frequency range (Hz) per the trial (100 - 10000 Hz). */
export const MIN_TINNITUS_HZ = 100;
export const MAX_TINNITUS_HZ = 10000;

/**
 * Fraction of each tone slot that is actually sounded. A short tone followed
 * by a brief gap within its slot avoids clicks and matches the "short
 * sinusoidal tones" description while keeping tones non-overlapping.
 */
const TONE_DUTY = 0.5;

/** Peak amplitude for every tone (equal loudness). Headroom left below 1.0. */
const TONE_AMPLITUDE = 0.6;

// ---------------------------------------------------------------------------
// Frequency computation
// ---------------------------------------------------------------------------

/**
 * Compute the four CR tone frequencies for a given tinnitus frequency.
 *
 * The tones are equidistant on a logarithmic scale across [0.5*ft, 2*ft].
 * For NUM_TONES points this yields, with ratio r = UPPER/LOWER = 4:
 *   f_i = 0.5*ft * r^(i/(NUM_TONES-1)),  i = 0..NUM_TONES-1
 * The resulting set is symmetric (in log space) about ft, placing an equal
 * number of tones below and above the tinnitus frequency.
 *
 * @param tinnitusHz tinnitus frequency ft in Hz
 * @returns ascending array of NUM_TONES tone frequencies in Hz
 */
export function computeToneFrequencies(tinnitusHz: number): number[] {
  const lower = LOWER_FACTOR * tinnitusHz;
  const ratio = UPPER_FACTOR / LOWER_FACTOR; // = 4 (two octaves)
  const freqs: number[] = [];
  for (let i = 0; i < NUM_TONES; i++) {
    const exponent = i / (NUM_TONES - 1);
    freqs.push(lower * Math.pow(ratio, exponent));
  }
  return freqs;
}

// ---------------------------------------------------------------------------
// Random utilities
// ---------------------------------------------------------------------------

/**
 * Return a new array containing 0..n-1 in random order (Fisher-Yates).
 * Used to randomize the order of the four tones within each CR cycle.
 */
function randomPermutation(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Signal synthesis
// ---------------------------------------------------------------------------

export interface CrStimulusOptions {
  /** Tinnitus frequency ft in Hz. */
  tinnitusHz: number;
  /** Total duration in seconds (default 15 minutes). */
  durationS?: number;
  /** Sample rate in Hz (default 44100). */
  sampleRate?: number;
}

export interface CrStimulusResult {
  /** Mono PCM samples in [-1, 1]. */
  samples: Float32Array;
  /** Sample rate used. */
  sampleRate: number;
  /** The four computed tone frequencies (Hz, ascending). */
  toneFrequencies: number[];
  /** Total duration in seconds. */
  durationS: number;
}

/**
 * Render a single tone into the buffer at a given slot, applying a short
 * raised-cosine fade in/out to prevent audible clicks at onset/offset.
 *
 * @param buffer    destination sample buffer
 * @param startSample index of the first sample of the tone slot
 * @param slotSamples number of samples in the full slot
 * @param freq      tone frequency in Hz
 * @param sampleRate sample rate in Hz
 */
function renderTone(
  buffer: Float32Array,
  startSample: number,
  slotSamples: number,
  freq: number,
  sampleRate: number,
): void {
  // The tone occupies the first TONE_DUTY fraction of the slot; the rest is a
  // short intra-slot gap so successive tones do not overlap.
  const toneSamples = Math.floor(slotSamples * TONE_DUTY);
  // Fade length: ~5 ms or 10% of the tone, whichever is smaller.
  const fadeSamples = Math.min(
    Math.floor(sampleRate * 0.005),
    Math.floor(toneSamples / 2),
  );

  const twoPiFOverFs = (2 * Math.PI * freq) / sampleRate;

  for (let i = 0; i < toneSamples; i++) {
    const idx = startSample + i;
    if (idx >= buffer.length) break;

    let envelope = 1;
    if (i < fadeSamples) {
      // Raised-cosine fade-in.
      envelope = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
    } else if (i >= toneSamples - fadeSamples) {
      // Raised-cosine fade-out.
      const k = toneSamples - 1 - i;
      envelope = 0.5 * (1 - Math.cos((Math.PI * k) / fadeSamples));
    }

    buffer[idx] += TONE_AMPLITUDE * envelope * Math.sin(twoPiFOverFs * i);
  }
}

/**
 * Generate the full acoustic CR neuromodulation stimulus as mono PCM samples.
 *
 * Structure (all per paper):
 *   - The timeline is divided into CR cycles of CYCLE_DURATION_S seconds.
 *   - Cycles are grouped into repeating blocks of ON_CYCLES stimulation cycles
 *     followed by OFF_CYCLES silent cycles (3:2 ON-OFF pattern).
 *   - Each stimulation cycle is divided into NUM_TONES equal slots; the four
 *     tones are assigned to the slots in a fresh random order every cycle.
 *   - Silent cycles contain no tones.
 */
export function generateCrStimulus(
  options: CrStimulusOptions,
): CrStimulusResult {
  const sampleRate = options.sampleRate ?? 44100;
  const durationS = options.durationS ?? DEFAULT_DURATION_S;
  const tinnitusHz = options.tinnitusHz;

  const toneFrequencies = computeToneFrequencies(tinnitusHz);

  const totalSamples = Math.floor(durationS * sampleRate);
  const samples = new Float32Array(totalSamples);

  const cycleSamples = Math.floor(CYCLE_DURATION_S * sampleRate);
  const slotSamples = Math.floor(cycleSamples / NUM_TONES);
  const blockCycles = ON_CYCLES + OFF_CYCLES; // 5 cycles per 3:2 block

  // Walk the timeline cycle by cycle.
  let cycleIndex = 0;
  for (
    let cycleStart = 0;
    cycleStart < totalSamples;
    cycleStart += cycleSamples, cycleIndex++
  ) {
    const positionInBlock = cycleIndex % blockCycles;
    const isOnCycle = positionInBlock < ON_CYCLES;

    if (!isOnCycle) {
      // Silent (OFF) cycle: leave samples as zero.
      continue;
    }

    // Random order of the four tones for this ON cycle.
    const order = randomPermutation(NUM_TONES);
    for (let slot = 0; slot < NUM_TONES; slot++) {
      const toneIdx = order[slot];
      const freq = toneFrequencies[toneIdx];
      const slotStart = cycleStart + slot * slotSamples;
      renderTone(samples, slotStart, slotSamples, freq, sampleRate);
    }
  }

  return { samples, sampleRate, toneFrequencies, durationS };
}

// ---------------------------------------------------------------------------
// WAV encoding (16-bit PCM, mono)
// ---------------------------------------------------------------------------

/**
 * Encode mono Float32 samples ([-1, 1]) into a 16-bit PCM WAV file.
 *
 * @returns a Blob with MIME type audio/wav
 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Blob {
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF header
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // file size - 8
  writeString(8, 'WAVE');

  // fmt chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample

  // data chunk
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp and convert to signed 16-bit.
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}

/**
 * Convenience: generate the CR stimulus and return it as an encoded WAV Blob
 * together with the computed metadata.
 */
export function generateCrWav(options: CrStimulusOptions): {
  blob: Blob;
  toneFrequencies: number[];
  durationS: number;
  sampleRate: number;
} {
  const result = generateCrStimulus(options);
  const blob = encodeWav(result.samples, result.sampleRate);
  return {
    blob,
    toneFrequencies: result.toneFrequencies,
    durationS: result.durationS,
    sampleRate: result.sampleRate,
  };
}
