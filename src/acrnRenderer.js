// Offline renderer that reproduces the live ACRN sequence played by App.js,
// using the native Web Audio API (OfflineAudioContext). It renders the exact
// same CR neuromodulation protocol (Tass et al. 2012) as the live playback,
// via the shared crProtocol module, so the exported WAV matches the app.
//
// The live chain (Tone.js 0.12) for the sequence is:
//   Tone.PolySynth(6, Tone.Synth, { oscillator: sine,
//       envelope: { attack: 0.1, decay: 0.0, sustain: 0.07, release: 0.08 } })
//   -> Tone.Master (volume in dB) -> destination
//
// Per-note behavior (verified against Tone 0.12 source):
//   triggerAttackRelease(freq, "4n", time):
//     - oscillator: sine, starts at `time`
//     - gain (AmplitudeEnvelope):
//         attack  (linear): ramp 0 -> 1 over `attack` seconds from `time`
//         decay   = 0  -> skipped entirely, so gain stays at the peak (1)
//                      until release (this is a real quirk of the live app)
//         release (exponential, i.e. setTargetAtTime toward 0) starts at
//                      time + duration("4n"), timeConstant = ln(release+1)/ln(200)
//     - oscillator stops at time + duration + release
//
// Protocol timing (from constants / crProtocol):
//   Cycle repetition rate 1.5 Hz => each tone ("4n") lasts TONE_SECONDS.
//   3:2 ON-OFF pattern: STEPS_PER_PERIOD steps per period, driven by
//   buildPatternPeriod(ft). Silent steps are null.

import * as constants from './constants';
import {buildPatternPeriod, STEPS_PER_PERIOD} from './crProtocol';
import {audioBufferToWav} from './wavEncoder';

// --- Timing mirrored from the shared protocol constants ---
const STEP_SECONDS = constants.TONE_SECONDS;        // one protocol step ("4n")
const QUARTER_NOTE_SECONDS = constants.TONE_SECONDS; // "4n" duration for triggerAttackRelease

// Envelope settings from App.js synth config
const ENV_ATTACK = 0.1;
const ENV_DECAY = 0.0;
const ENV_SUSTAIN = 0.07;
const ENV_RELEASE = 0.08;

// Tone's exponential "targetRampTo" time constant for a given ramp time.
// From Tone/core/Param.js exponentialApproachValueAtTime:
//   timeConstant = Math.log(rampTime + 1) / Math.log(200)
function toneTargetTimeConstant(rampTime) {
    return Math.log(rampTime + 1) / Math.log(200);
}

/**
 * Schedule a single ACRN note on the offline context, reproducing the
 * Tone.Synth sine + ADSR envelope behavior.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination node to connect into (e.g. a master gain)
 * @param {number} frequency
 * @param {number} startTime when the attack begins (seconds)
 */
function scheduleNote(ctx, destination, frequency, startTime) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, startTime);

    const gain = ctx.createGain();

    // Attack: linear ramp 0 -> 1 over ENV_ATTACK.
    // Tone anchors the start with a tiny non-zero value (_minOutput = 0.00001).
    gain.gain.setValueAtTime(0.00001, startTime);
    gain.gain.linearRampToValueAtTime(1, startTime + ENV_ATTACK);

    // Decay is 0.0 in the live config, so Tone skips the decay ramp entirely
    // (the `if (decay)` guard is falsy). The gain therefore stays at the peak
    // value of 1 until the release — we intentionally do NOT ramp to sustain.

    // Release: exponential approach toward 0 (Tone targetRampTo => setTargetAtTime).
    // It starts at startTime + duration("4n").
    const releaseTime = startTime + QUARTER_NOTE_SECONDS;
    gain.gain.setTargetAtTime(0, releaseTime, toneTargetTimeConstant(ENV_RELEASE));

    // Oscillator lifetime: starts at attack, stops at releaseTime + release.
    osc.connect(gain);
    gain.connect(destination);
    osc.start(startTime);
    osc.stop(releaseTime + ENV_RELEASE);
}

/**
 * Render `durationSeconds` of the CR sequence for the given base frequency
 * to an AudioBuffer using an OfflineAudioContext.
 *
 * The scheduling walks the 3:2 ON-OFF protocol step-by-step across the whole
 * duration, rebuilding each period with buildPatternPeriod so every ON cycle
 * gets a fresh random tone order — identical to the live playback.
 *
 * @param {number} baseFreq the current tinnitus frequency selected in the app
 * @param {number} durationSeconds total render length
 * @param {number} sampleRate
 * @returns {Promise<AudioBuffer>}
 */
export function renderSegment(baseFreq, durationSeconds, sampleRate = 44100) {
    // Wrap everything in a Promise so that ANY failure — including synchronous
    // errors from constructing the OfflineAudioContext or scheduling nodes —
    // is delivered through rejection. Previously these synchronous errors
    // escaped the caller's .catch, leaving the UI stuck with no feedback.
    return new Promise((resolve, reject) => {
        try {
            const totalFrames = Math.ceil(durationSeconds * sampleRate);

            const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            if (!OfflineCtx) {
                throw new Error('OfflineAudioContext is not supported in this browser.');
            }

            // The constructor signature differs across browsers. Prefer the
            // options-object form, then fall back to the positional form.
            let ctx;
            try {
                ctx = new OfflineCtx({
                    numberOfChannels: 1,
                    length: totalFrames,
                    sampleRate: sampleRate,
                });
            } catch (optErr) {
                ctx = new OfflineCtx(1, totalFrames, sampleRate);
            }

            // A master gain mirrors Tone.Master. Because a note's release tail
            // overlaps the next note's attack and voices sum with no
            // normalization, apply modest headroom to avoid hard clipping.
            const master = ctx.createGain();
            master.gain.setValueAtTime(0.7, 0);
            master.connect(ctx.destination);

            const totalSteps = Math.ceil(durationSeconds / STEP_SECONDS);

            // Walk every protocol step, rebuilding the 3:2 period as we loop.
            let pattern = buildPatternPeriod(baseFreq);
            let stepIndex = 0;

            for (let step = 0; step < totalSteps; step++) {
                const stepTime = step * STEP_SECONDS;
                const frequency = pattern[stepIndex];
                if (frequency !== null && frequency !== undefined) {
                    scheduleNote(ctx, master, frequency, stepTime);
                }
                stepIndex++;
                if (stepIndex >= pattern.length) {
                    pattern = buildPatternPeriod(baseFreq);
                    stepIndex = 0;
                }
            }

            // Support both the modern Promise-based API and the legacy
            // callback-based (oncomplete) API. Some engines only resolve via
            // one of the two, so we wire up both and take whichever fires.
            let settled = false;
            const finish = (buffer) => {
                if (settled) return;
                settled = true;
                resolve(buffer);
            };

            ctx.oncomplete = (event) => finish(event.renderedBuffer);

            const maybePromise = ctx.startRendering();
            if (maybePromise && typeof maybePromise.then === 'function') {
                maybePromise.then(finish).catch(reject);
            }
        } catch (err) {
            reject(err);
        }
    });
}

// Duration of the segment that is actually rendered with the Web Audio engine.
// The CR pattern repeats every period (STEPS_PER_PERIOD steps). We render a
// whole number of periods, then tile that segment to reach the requested total
// length. This keeps the offline render tiny (seconds of audio) instead of
// allocating a huge buffer for the full track — which is what was causing the
// export to hang / fail silently for long durations.
const PERIOD_SECONDS = STEPS_PER_PERIOD * STEP_SECONDS; // one 3:2 period (~3.333 s)
// ~18 periods ≈ 60 s. Must be a whole number of periods so the tiled seams
// land exactly on a pattern boundary (no clicks, no timing drift).
const SEGMENT_PERIODS = 18;
const SEGMENT_SECONDS = SEGMENT_PERIODS * PERIOD_SECONDS;

/**
 * Render the full ACRN track for the given frequency and total duration, and
 * return it as a WAV Blob.
 *
 * Internally this renders one SEGMENT_SECONDS-long segment with the offline
 * audio engine (fast, small) and tiles its PCM samples to fill the full
 * duration. Because the segment is a whole number of CR periods, the loop
 * points align exactly on pattern boundaries.
 *
 * @param {number} baseFreq current tinnitus frequency
 * @param {number} durationSeconds total output length
 * @param {number} sampleRate
 * @returns {Promise<Blob>} a WAV Blob of the full track
 */
export function renderAcrnWav(baseFreq, durationSeconds = 3600, sampleRate = 44100) {
    // If the requested duration is already short, just render it directly.
    const segmentSeconds = Math.min(SEGMENT_SECONDS, durationSeconds);

    return renderSegment(baseFreq, segmentSeconds, sampleRate).then((segmentBuffer) => {
        const segFrames = segmentBuffer.length;
        const segData = segmentBuffer.getChannelData(0);

        const totalFrames = Math.ceil(durationSeconds * sampleRate);

        // Build the full mono track by tiling the segment's samples. This is
        // a plain Float32Array copy — cheap and memory-predictable compared to
        // rendering the full duration through Web Audio.
        const fullData = new Float32Array(totalFrames);
        let offset = 0;
        while (offset < totalFrames) {
            const remaining = totalFrames - offset;
            const copyLen = Math.min(segFrames, remaining);
            fullData.set(segData.subarray(0, copyLen), offset);
            offset += copyLen;
        }

        // Wrap the Float32Array in a minimal AudioBuffer-like object that the
        // WAV encoder understands (it only needs numberOfChannels, sampleRate,
        // length and getChannelData).
        const fullBuffer = {
            numberOfChannels: 1,
            sampleRate: sampleRate,
            length: totalFrames,
            getChannelData: () => fullData,
        };

        return audioBufferToWav(fullBuffer);
    });
}

export const RENDER_CONSTANTS = {
    STEP_SECONDS,
    STEPS_PER_PERIOD,
    PERIOD_SECONDS,
    SEGMENT_SECONDS,
    ENV_ATTACK,
    ENV_DECAY,
    ENV_SUSTAIN,
    ENV_RELEASE,
};
