import { useEffect, useRef, useState } from 'react'
import './App.css'
import {
  CYCLE_RATE_HZ,
  DEFAULT_DURATION_S,
  MAX_TINNITUS_HZ,
  MIN_TINNITUS_HZ,
  NUM_TONES,
  OFF_CYCLES,
  ON_CYCLES,
  computeToneFrequencies,
  generateCrStimulus,
  generateCrWav,
} from './crEngine'

/**
 * Length of the live preview, in seconds. 10 s spans two full 3:2 ON-OFF
 * blocks (each block = 5 cycles x 1/1.5 s ≈ 3.33 s), so the user hears the
 * complete repeating pattern.
 */
const PREVIEW_DURATION_S = 10

/** One hour, in seconds. A 1-hour session is within the paper's 4-6 h/day. */
const ONE_HOUR_S = 60 * 60

/** Format a frequency for display (Hz or kHz). */
function formatHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`
  return `${Math.round(hz)} Hz`
}

/** Format a duration in seconds as "M min S s". */
function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = Math.round(totalSeconds % 60)
  return s === 0 ? `${m} min` : `${m} min ${s} s`
}

function App() {
  const [tinnitusHz, setTinnitusHz] = useState(4000)
  // Duration (in seconds) currently being generated, or null when idle. Lets
  // us show a per-button loading state.
  const [generatingDurationS, setGeneratingDurationS] = useState<number | null>(
    null,
  )
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  // Duration (in seconds) of the WAV currently available for download.
  const [downloadDurationS, setDownloadDurationS] = useState<number | null>(
    null,
  )
  const [isPreviewing, setIsPreviewing] = useState(false)
  // Whether the pure matching tone is currently sounding.
  const [isMatching, setIsMatching] = useState(false)

  // Web Audio context and the currently playing source, kept in refs so they
  // persist across renders and can be stopped/cleaned up.
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  // Oscillator + gain used for the continuous pure matching tone.
  const oscRef = useRef<OscillatorNode | null>(null)
  const oscGainRef = useRef<GainNode | null>(null)

  // Revoke the previous object URL whenever it changes or on unmount to avoid
  // leaking memory (the WAV blobs are large).
  const urlRef = useRef<string | null>(null)
  useEffect(() => {
    urlRef.current = downloadUrl
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [downloadUrl])

  const clamped = Math.min(
    MAX_TINNITUS_HZ,
    Math.max(MIN_TINNITUS_HZ, tinnitusHz || MIN_TINNITUS_HZ),
  )
  const toneFrequencies = computeToneFrequencies(clamped)

  const handleGenerate = async (durationS: number) => {
    setGeneratingDurationS(durationS)
    // Revoke any previous download before building a new one.
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl)
      setDownloadUrl(null)
      setDownloadDurationS(null)
    }
    // Yield to the browser so the loading state can paint before the
    // synchronous (CPU-heavy) synthesis runs.
    await new Promise((resolve) => setTimeout(resolve, 30))
    try {
      const { blob } = generateCrWav({ tinnitusHz: clamped, durationS })
      const url = URL.createObjectURL(blob)
      setDownloadUrl(url)
      setDownloadDurationS(durationS)
    } finally {
      setGeneratingDurationS(null)
    }
  }

  /** Build a download filename for a given duration in seconds. */
  const fileNameFor = (durationS: number) => {
    const label =
      durationS % 3600 === 0
        ? `${durationS / 3600}h`
        : `${Math.round(durationS / 60)}min`
    return `acoustic-cr-${Math.round(clamped)}hz-${label}.wav`
  }

  const isGenerating = generatingDurationS !== null

  /** Lazily create (and resume) a single shared AudioContext. */
  const getAudioContext = (): AudioContext => {
    let ctx = audioCtxRef.current
    if (!ctx) {
      ctx = new AudioContext()
      audioCtxRef.current = ctx
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }

  /** Stop the continuous pure matching tone with a short fade-out. */
  const stopMatchingTone = () => {
    const osc = oscRef.current
    const gain = oscGainRef.current
    const ctx = audioCtxRef.current
    if (osc && gain && ctx) {
      const now = ctx.currentTime
      // Quick ramp to zero to avoid an audible click, then stop.
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(0, now + 0.03)
      osc.stop(now + 0.04)
      osc.onended = () => {
        osc.disconnect()
        gain.disconnect()
      }
    }
    oscRef.current = null
    oscGainRef.current = null
    setIsMatching(false)
  }

  /**
   * Play a continuous pure sine tone at the selected frequency so the user can
   * match it to the pitch of their tinnitus. This is a plain reference tone,
   * not the CR stimulus.
   */
  const handleMatchingTone = () => {
    if (isMatching) {
      stopMatchingTone()
      return
    }

    const ctx = getAudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(clamped, ctx.currentTime)

    // Fade in to a gentle, comfortable level to avoid a click on start.
    const level = 0.2
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(level, ctx.currentTime + 0.03)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()

    oscRef.current = osc
    oscGainRef.current = gain
    setIsMatching(true)
  }

  /** Stop any ongoing preview playback and reset state. */
  const stopPreview = () => {
    if (sourceRef.current) {
      try {
        sourceRef.current.onended = null
        sourceRef.current.stop()
      } catch {
        // Source may already have stopped; ignore.
      }
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    setIsPreviewing(false)
  }

  /**
   * Play a short protocol-accurate sample through the Web Audio API. The
   * sample is produced by the exact same CR engine as the full WAV, so it
   * honours every paper parameter (log-spaced tones, 1.5 Hz cycles, random
   * tone order, 3:2 ON-OFF pattern).
   */
  const handlePreview = () => {
    // Toggle off if already playing.
    if (isPreviewing) {
      stopPreview()
      return
    }

    const ctx = getAudioContext()

    // Render the sample with the engine, then copy into an AudioBuffer.
    const { samples, sampleRate } = generateCrStimulus({
      tinnitusHz: clamped,
      durationS: PREVIEW_DURATION_S,
      sampleRate: ctx.sampleRate,
    })
    const buffer = ctx.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.onended = () => {
      source.disconnect()
      if (sourceRef.current === source) sourceRef.current = null
      setIsPreviewing(false)
    }
    sourceRef.current = source
    source.start()
    setIsPreviewing(true)
  }

  // Stop playback and close the audio context on unmount.
  useEffect(() => {
    return () => {
      if (sourceRef.current) {
        try {
          sourceRef.current.stop()
        } catch {
          // ignore
        }
        sourceRef.current.disconnect()
        sourceRef.current = null
      }
      if (oscRef.current) {
        try {
          oscRef.current.stop()
        } catch {
          // ignore
        }
        oscRef.current.disconnect()
        oscRef.current = null
      }
      if (audioCtxRef.current) {
        void audioCtxRef.current.close()
        audioCtxRef.current = null
      }
    }
  }, [])

  // Stop a running preview whenever the tinnitus frequency changes, so the
  // sample always matches the currently selected frequency. The pure matching
  // tone instead updates its pitch live so the user can tune it in real time.
  useEffect(() => {
    stopPreview()
    if (oscRef.current && audioCtxRef.current) {
      oscRef.current.frequency.setValueAtTime(
        clamped,
        audioCtxRef.current.currentTime,
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clamped])

  return (
    <main id="center">
      <header className="intro">
        <h1>Acoustic CR Neuromodulation</h1>
        <p className="lede">
          Generate a 15-minute coordinated reset (CR) stimulation signal for
          your tinnitus frequency, following the protocol of Tass et al.
          (2012), <em>Counteracting tinnitus by acoustic coordinated reset
          neuromodulation</em> (stimulation group&nbsp;G1).
        </p>
      </header>

      <section className="panel" aria-labelledby="select-heading">
        <h2 id="select-heading">1. Select your tinnitus frequency</h2>
        <p className="hint">
          Match this to the pitch of your tinnitus tone (range{' '}
          {MIN_TINNITUS_HZ}&nbsp;Hz&ndash;{MAX_TINNITUS_HZ / 1000}&nbsp;kHz).
        </p>

        <div className="freq-control">
          <input
            type="range"
            min={MIN_TINNITUS_HZ}
            max={MAX_TINNITUS_HZ}
            step={10}
            value={clamped}
            aria-label="Tinnitus frequency slider"
            onChange={(e) => setTinnitusHz(Number(e.target.value))}
          />
          <div className="freq-number">
            <input
              type="number"
              min={MIN_TINNITUS_HZ}
              max={MAX_TINNITUS_HZ}
              step={1}
              value={tinnitusHz}
              aria-label="Tinnitus frequency in Hz"
              onChange={(e) => setTinnitusHz(Number(e.target.value))}
            />
            <span className="unit">Hz</span>
          </div>
        </div>

        <div className="match-row">
          <button
            type="button"
            className="match-tone"
            onClick={handleMatchingTone}
            aria-pressed={isMatching}
          >
            {isMatching
              ? '\u25A0 Stop tone'
              : '\u266A Play tone to match my tinnitus'}
          </button>
          <span className="hint small match-hint">
            Plays a steady pure tone at {formatHz(clamped)}. Adjust the slider
            while it plays until it matches your tinnitus pitch.
          </span>
        </div>

        <div className="tones">
          <span className="tones-label">
            The four CR tones (log-spaced in [0.5&middot;f
            <sub>t</sub>, 2&middot;f<sub>t</sub>]):
          </span>
          <ul className="tone-list">
            {toneFrequencies.map((f, i) => (
              <li key={i} className="tone-chip">
                <span className="tone-index">f{i + 1}</span>
                {formatHz(f)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="panel" aria-labelledby="generate-heading">
        <h2 id="generate-heading">2. Preview, generate &amp; download</h2>
        <div className="actions">
          <button
            type="button"
            className="preview"
            onClick={handlePreview}
            aria-pressed={isPreviewing}
          >
            {isPreviewing
              ? '\u25A0 Stop preview'
              : `\u25B6 Preview sample (${PREVIEW_DURATION_S}s)`}
          </button>
          <button
            type="button"
            className="generate"
            onClick={() => handleGenerate(DEFAULT_DURATION_S)}
            disabled={isGenerating}
          >
            {generatingDurationS === DEFAULT_DURATION_S
              ? 'Generating\u2026'
              : 'Generate 15-min WAV'}
          </button>
          <button
            type="button"
            className="generate"
            onClick={() => handleGenerate(ONE_HOUR_S)}
            disabled={isGenerating}
          >
            {generatingDurationS === ONE_HOUR_S
              ? 'Generating\u2026'
              : 'Generate 1-hour WAV'}
          </button>
        </div>

        {downloadUrl && downloadDurationS !== null && !isGenerating && (
          <a
            className="download"
            href={downloadUrl}
            download={fileNameFor(downloadDurationS)}
          >
            Download {fileNameFor(downloadDurationS)} (
            {formatDuration(downloadDurationS)})
          </a>
        )}
        <p className="hint small">
          The preview plays a short, protocol-accurate excerpt. A 1-hour
          session falls within the paper&rsquo;s 4&ndash;6&nbsp;h/day regimen
          and may take a few seconds to build. Listen through headphones at a
          comfortable, just-audible volume.
        </p>
      </section>

      <section className="panel protocol" aria-labelledby="protocol-heading">
        <h2 id="protocol-heading">Protocol parameters</h2>
        <dl className="protocol-grid">
          <div>
            <dt>CR tones</dt>
            <dd>{NUM_TONES}, centered around f<sub>t</sub></dd>
          </div>
          <div>
            <dt>Spacing</dt>
            <dd>
              logarithmic, [0.5&middot;f<sub>t</sub>, 2&middot;f<sub>t</sub>]
            </dd>
          </div>
          <div>
            <dt>Cycle rate</dt>
            <dd>{CYCLE_RATE_HZ} Hz (lower &delta; band)</dd>
          </div>
          <div>
            <dt>Tones per cycle</dt>
            <dd>{NUM_TONES}, random order</dd>
          </div>
          <div>
            <dt>ON&ndash;OFF pattern</dt>
            <dd>
              {ON_CYCLES} stim : {OFF_CYCLES} silent cycles
            </dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(DEFAULT_DURATION_S)}</dd>
          </div>
        </dl>
        <p className="disclaimer">
          For research and educational use only. This is not a medical device
          and does not provide medical advice.
        </p>
      </section>
    </main>
  )
}

export default App
