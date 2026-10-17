// Shared implementation of the acoustic CR neuromodulation protocol
// as described in Tass et al. 2012, "Counteracting tinnitus by acoustic
// coordinated reset neuromodulation" (Restorative Neurology and Neuroscience
// 30 (2012) 137-159).
//
// This is the single source of truth for both the live playback (App.js)
// and the offline WAV export (acrnRenderer.js), so the two modes stay in sync.
//
// Protocol summary (from section 2.5 "Stimulation protocol" and Fig. 1):
//   - 4 short sinusoidal tones per cycle, centered around the tinnitus
//     frequency ft, with an equal number below and above ft.
//   - The 4 tones are placed equidistantly on a LOGARITHMIC scale within
//     the interval [0.5*ft, 2*ft].
//   - The 4 tones are played in random order within each cycle.
//   - Temporal pattern is 3:2 ON-OFF: 3 stimulation cycles followed by
//     2 silent cycles, repeated periodically.
//   - Cycle repetition rate is 1.5 Hz (lower delta band).

import * as constants from './constants';

/**
 * Compute the 4 CR stimulation tone frequencies for a given tinnitus
 * frequency ft, placed equidistantly on a logarithmic scale within
 * [0.5*ft, 2*ft] (Tass et al. 2012).
 *
 * With 4 points equidistant in log space across a factor-4 interval, the
 * ratio between consecutive tones is 4^(1/3) ~= 1.5874. The multipliers of
 * ft are therefore: 0.5, 0.7937, 1.2599, 2.0 (i.e. an equal number below and
 * above ft, since 0.7937 < 1 < 1.2599).
 *
 * @param {number} ft tinnitus frequency in Hz
 * @returns {number[]} the 4 tone frequencies in Hz, ascending
 */
export function generateFreqs(ft) {
    const low = constants.FREQ_INTERVAL_LOW;   // 0.5
    const high = constants.FREQ_INTERVAL_HIGH; // 2.0
    const n = constants.TONES_PER_CYCLE;       // 4

    const logLow = Math.log(low);
    const logHigh = Math.log(high);
    const freqs = [];
    for (let i = 0; i < n; i++) {
        // i / (n - 1) spans [0, 1] inclusive, so the first tone sits exactly
        // at 0.5*ft and the last exactly at 2*ft.
        const t = i / (n - 1);
        const multiplier = Math.exp(logLow + t * (logHigh - logLow));
        freqs.push(Math.round(ft * multiplier));
    }
    return freqs;
}

/**
 * Fisher-Yates shuffle (in place), used to randomize the tone order within
 * each stimulation cycle.
 * @param {Array} a
 * @returns {Array} the same array, shuffled
 */
export function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Build one full ON-OFF period of the CR pattern as a flat array of steps.
 * Each step is either a frequency (number) to play, or null for a silent step.
 *
 * Structure: ON_CYCLES cycles of TONES_PER_CYCLE random-ordered tones, then
 * OFF_CYCLES * TONES_PER_CYCLE silent steps. The tone order is randomized
 * independently for each ON cycle.
 *
 * @param {number} ft tinnitus frequency
 * @returns {Array<number|null>} steps for one 3:2 period
 */
export function buildPatternPeriod(ft) {
    const baseFreqs = generateFreqs(ft);
    const steps = [];

    // ON cycles: each cycle is the 4 tones in a fresh random order.
    for (let c = 0; c < constants.ON_CYCLES; c++) {
        const cycleTones = shuffle(baseFreqs.slice());
        for (let i = 0; i < cycleTones.length; i++) {
            steps.push(cycleTones[i]);
        }
    }

    // OFF cycles: silent steps.
    const silentSteps = constants.OFF_CYCLES * constants.TONES_PER_CYCLE;
    for (let i = 0; i < silentSteps; i++) {
        steps.push(null);
    }

    return steps;
}

// Number of steps in one complete 3:2 ON-OFF period.
export const STEPS_PER_PERIOD =
    (constants.ON_CYCLES + constants.OFF_CYCLES) * constants.TONES_PER_CYCLE; // 20
