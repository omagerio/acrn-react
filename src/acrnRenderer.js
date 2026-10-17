// Offline renderer that reproduces the live ACRN sequence played by App.js,
// using the native Web Audio API (OfflineAudioContext). The goal is to match,
// as closely as possible, the audio characteristics of the live playback
// driven by Tone.js 0.12 so the exported WAV sounds the same as the app.
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
// Sequence timing:
//   Tone.Transport.bpm.value = 90 * 4 = 360
//   new Tone.Sequence(cb, freqSeq) with no subdivision -> default "4n"
//   "4n" at 360 bpm = (60/360) * 1 = 0.166666... s per step
//   freqSeq has 21 top-level entries (16 zeros + 5 single-element subarrays),
//   so the sequence advances one callback per step, 21 steps per sequence loop.
//
//   The callback keeps a persistent `seqCount` (closure in playAcrn) that is NOT
//   reset per sequence loop; it is reset by its own logic when it reaches
//   maxPatternLength + REST_LENGTH. We reproduce that exact counter logic below.

import * as constants from './constants';

// --- Constants mirrored from the live App.js configuration ---
const BPM = 90 * 4;                 // Tone.Transport.bpm.value in App.componentDidMount
const SECONDS_PER_BEAT = 60 / BPM;  // Tone _beatsToUnits(1)
const STEP_SECONDS = SECONDS_PER_BEAT; // "4n" (default Sequence subdivision) = 1 beat
const QUARTER_NOTE_SECONDS = SECONDS_PER_BEAT; // "4n" duration passed to triggerAttackRelease

// Envelope settings from App.js synth config
const ENV_ATTACK = 0.1;
const ENV_DECAY = 0.0;
const ENV_SUSTAIN = 0.07;
const ENV_RELEASE = 0.08;

// Number of top-level steps in the generated freqSeq (16 active + REST_LENGTH + 1 rest slots)
const SEQ_STEPS = (constants.LOOP_REPEAT * 4) + (constants.REST_LENGTH + 1); // 16 + 5 = 21

// Tone's exponential "targetRampTo" time constant for a given ramp time.
// From Tone/core/Param.js exponentialApproachValueAtTime:
//   timeConstant = Math.log(rampTime + 1) / Math.log(200)
function toneTargetTimeConstant(rampTime) {
    return Math.log(rampTime + 1) / Math.log(200);
}

// generateFreqs mirrors App.generateFreqs exactly.
function generateFreqs(currentFreq) {
    return [
        Math.floor(currentFreq * 0.773 - 44.5),
        Math.floor(currentFreq * 0.903 - 21.5),
        Math.floor(currentFreq * 1.09 + 52),
        Math.floor(currentFreq * 1.395 + 26.5),
    ];
}

// Fisher-Yates shuffle, identical to App.shuffle.
function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
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
 * Render `durationSeconds` of the ACRN sequence for the given base frequency
 * to an AudioBuffer using an OfflineAudioContext.
 *
 * The scheduling reproduces App.playAcrn's seqCount logic step-by-step across
 * the whole duration, including the shuffle-and-refill of the frequency list
 * and the rest handling.
 *
 * @param {number} baseFreq the current frequency selected in the app
 * @param {number} durationSeconds total render length (default 1 hour)
 * @param {number} sampleRate
 * @returns {Promise<AudioBuffer>}
 */
export function renderAcrnSequence(baseFreq, durationSeconds = 3600, sampleRate = 44100) {
    const totalFrames = Math.ceil(durationSeconds * sampleRate);

    // OfflineAudioContext signature varies slightly across browsers; the
    // (numChannels, length, sampleRate) form is the most widely supported.
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OfflineCtx(1, totalFrames, sampleRate);

    // A master gain mirrors Tone.Master. The live export uses full volume
    // (0 dB => gain 1). Because consecutive notes overlap (a note's release
    // tail overlaps the next note's attack) and the PolySynth sums voices with
    // no normalization, we apply a modest headroom factor to avoid hard
    // clipping while preserving the relative dynamics.
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.7, 0);
    master.connect(ctx.destination);

    const freqList = generateFreqs(baseFreq);
    const maxPatternLength = constants.LOOP_REPEAT * freqList.length; // 16
    let currentFreqList = [];
    let seqCount = 0;

    // Walk every sequence step across the full duration. Each step is one
    // Tone.Sequence callback invocation at STEP_SECONDS spacing.
    const totalSteps = Math.ceil(durationSeconds / STEP_SECONDS);

    for (let step = 0; step < totalSteps; step++) {
        const stepTime = step * STEP_SECONDS;

        // Reproduce the exact counter logic from App.playAcrn:
        //   seqCount++ at the start of each callback.
        seqCount++;

        if (seqCount < maxPatternLength) {
            if (currentFreqList.length === 0) {
                currentFreqList = shuffle(freqList.slice());
            }
            const frequency = currentFreqList.pop();
            scheduleNote(ctx, master, frequency, stepTime);
        } else {
            if (seqCount < maxPatternLength + constants.REST_LENGTH) {
                // rest: do nothing
            } else {
                seqCount = 0;
            }
        }
    }

    return ctx.startRendering();
}

export const RENDER_CONSTANTS = {
    BPM,
    STEP_SECONDS,
    SEQ_STEPS,
    ENV_ATTACK,
    ENV_DECAY,
    ENV_SUSTAIN,
    ENV_RELEASE,
};
