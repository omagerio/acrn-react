export const MIN_FREQ = 1;
export const MAX_FREQ = 15000;

export const PLAY_TONE_TEXT = "Play Tone";
export const STOP_TONE_TEXT = "Stop Tone";
export const PLAY_SEQ_TEXT = "Play Pattern";
export const STOP_SEQ_TEXT = "Stop Pattern";

export const EXPORT_WAV_TEXT = "Export 15 Min WAV";
export const EXPORT_WAV_BUSY_TEXT = "Generating WAV...";

// length of the exported track, in seconds (15 minutes)
export const EXPORT_DURATION_SECONDS = 15 * 60;

export const VOLUME_KEY = "volume";
export const FREQ_KEY = "freq";
export const PLAYER_STATE_KEY = "playerState";

// initial config values
export const DEFAULT_FREQ = 1000;
export const DEFAULT_VOLUME = -10;

// --- CR neuromodulation protocol parameters (Tass et al. 2012) ---
// The protocol uses 4 tones per cycle, played in random order, with a
// 3:2 ON-OFF pattern: 3 stimulation cycles followed by 2 silent cycles.
export const TONES_PER_CYCLE = 4;      // 4 tones per cycle
export const ON_CYCLES = 3;            // 3 stimulation cycles
export const OFF_CYCLES = 2;           // 2 silent cycles (3:2 ON-OFF)

// Cycle repetition rate = 1.5 Hz (lower delta band). One cycle of 4 tones
// therefore lasts 1 / 1.5 s, and each tone occupies a quarter of that.
export const CYCLE_RATE_HZ = 1.5;
export const CYCLE_SECONDS = 1 / CYCLE_RATE_HZ;          // ~0.6667 s per cycle
export const TONE_SECONDS = CYCLE_SECONDS / TONES_PER_CYCLE; // ~0.16667 s per tone

// Stimulation tones are placed equidistantly on a logarithmic scale within
// the interval [0.5*ft, 2*ft] around the tinnitus frequency ft.
export const FREQ_INTERVAL_LOW = 0.5;  // lower bound multiplier of ft
export const FREQ_INTERVAL_HIGH = 2.0; // upper bound multiplier of ft

// Legacy constants kept for backward compatibility with older state.
// (No longer used to drive the sequence timing.)
export const LOOP_REPEAT = 4;
export const REST_LENGTH = 4;

// constants
export const PLAYER_STATES = {
    PLAY_TONE: 0,
    PLAY_ACRN: 1
};
