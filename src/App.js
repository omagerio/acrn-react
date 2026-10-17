import './App.css';

import React, {Component} from 'react';
import * as constants from './constants';

import Slider from 'rc-slider';
import Tooltip from 'rc-tooltip';
import 'rc-slider/assets/index.css';

import {Button, ToggleButton, ToggleButtonGroup} from 'react-bootstrap';

import Tone from 'tone';
import StartAudioContext from 'startaudiocontext';

import {renderAcrnWav} from './acrnRenderer';
import {downloadBlob} from './wavEncoder';
import {generateFreqs, buildPatternPeriod, STEPS_PER_PERIOD} from './crProtocol';

class App extends Component {
    constructor(props, context) {
        super(props, context);


        // use local storage for volume and frequency
        let localVolume = this.getLocalStorageInt(constants.VOLUME_KEY, constants.DEFAULT_VOLUME);
        let localFreq = this.getLocalStorageInt(constants.FREQ_KEY, constants.DEFAULT_FREQ);
        let playerState = this.getLocalStorageInt(constants.PLAYER_STATE_KEY, constants.PLAYER_STATES.PLAY_TONE);

        let buttonText = constants.PLAY_TONE_TEXT;
        if (playerState === constants.PLAYER_STATES.PLAY_ACRN) {
            buttonText = constants.PLAY_SEQ_TEXT;
        }

        // setup initial state
        this.state = {
            freq: localFreq,
            volume: localVolume,
            playState: playerState,
            enableSlider: true,
            isPlaying: false,
            userStarted: false,
            isExporting: false,
            playButtonText: buttonText,
            synth: new Tone.PolySynth(6, Tone.Synth, {
                "oscillator": {
                    "type": "sine"
                },
                "envelope": {
                    "attack": 0.1,
                    "decay": 0.00,
                    "sustain": 0.07,
                    "release": 0.08,
                }
            }).toMaster(),
            osc: new Tone.Oscillator({
                "frequency": constants.DEFAULT_FREQ
            }).toMaster()
        }
    }

    getLocalStorageInt = (localKey, defaultValue) => {
        let localValue = localStorage.getItem(localKey);
        if (localValue === null) {
            return defaultValue
        } else {
            return parseInt(localValue, 10);
        }
    };


    componentDidMount = () => {
        //set the bpm and initialize sound context
        // Cycle repetition rate is 1.5 Hz (Tass et al. 2012): one cycle of 4
        // tones per 1/1.5 s, so each tone ("4n") lasts (1/1.5)/4 s. That makes
        // one quarter note = TONE_SECONDS, i.e. bpm = 60 / TONE_SECONDS = 360.
        Tone.Transport.bpm.value = 60 / constants.TONE_SECONDS;
        Tone.context.latencyHint = 'interactive';
        StartAudioContext(Tone.context, '.App');
        // make sure volume is off initially
        Tone.Master.volume.rampTo(-Infinity, 0.05);
    };

    handleTextFreqChange = (e) => {
        let value = parseInt(e.target.value, 10);
        if (!isNaN(value)) {
            this.handleFreqChange(value);
        }
    };

    handleFreqChange = value => {
        let {osc} = this.state;
        osc.frequency.value = value;

        this.setState({
            freq: value,
        });

        localStorage.setItem(constants.FREQ_KEY, value);

        // If the CR sequence is currently playing, rebuild it so the new
        // frequency's tones take effect immediately.
        let {isPlaying, playState, sequence} = this.state;
        if (isPlaying && playState === constants.PLAYER_STATES.PLAY_ACRN && sequence) {
            sequence.cancel();
            sequence.dispose();
            this.playAcrn();
        }
    };


    handleClickPlay = () => {
        let {isPlaying, volume, playState} = this.state;
        if (!isPlaying) {
            Tone.Transport.start();
            Tone.Master.volume.rampTo(volume, 0.05);
        } else {
            Tone.Master.volume.rampTo(-Infinity, 0.05);
            Tone.Transport.stop();
        }
        this.updatePlayState(!isPlaying, playState);
        this.setState({isPlaying: !isPlaying});
    };

    handleExportWav = () => {
        let {isExporting, isPlaying, playState, freq} = this.state;
        if (isExporting) {
            return;
        }

        // Stop any live playback so it does not compete with the export.
        if (isPlaying) {
            Tone.Master.volume.rampTo(-Infinity, 0.05);
            Tone.Transport.stop();
            this.updatePlayState(false, playState);
            this.setState({isPlaying: false});
        }

        this.setState({isExporting: true});

        // Render in a separate (offline) audio context. OfflineAudioContext
        // renders faster than realtime, so this should take seconds, not the
        // full track length. The try/catch is a belt-and-suspenders guard in
        // case renderAcrnSequence throws synchronously before returning its
        // promise; the renderer already wraps its work in a promise too.
        try {
            renderAcrnWav(freq, constants.EXPORT_DURATION_SECONDS)
                .then((blob) => {
                    downloadBlob(blob, `acrn-${freq}hz-15min.wav`);
                    this.setState({isExporting: false});
                })
                .catch((err) => {
                    // Surface the failure without leaving the button stuck.
                    console.error('WAV export failed:', err);
                    window.alert('Sorry, the WAV export failed: ' + (err && err.message ? err.message : err));
                    this.setState({isExporting: false});
                });
        } catch (err) {
            console.error('WAV export failed (sync):', err);
            window.alert('Sorry, the WAV export failed: ' + (err && err.message ? err.message : err));
            this.setState({isExporting: false});
        }
    };

    playAcrn = () => {
        let {synth, freq} = this.state;

        // Build one full 3:2 ON-OFF period (20 steps): 3 cycles of 4
        // random-ordered tones followed by 2 silent cycles (Tass et al. 2012).
        // A null step is silence. The tone order is randomized per ON cycle.
        let pattern = buildPatternPeriod(freq);
        let stepIndex = 0;

        // One Tone.Sequence step per protocol step. Each step is "4n", which at
        // the configured bpm equals TONE_SECONDS, giving the 1.5 Hz cycle rate.
        let newSequence = new Tone.Sequence((time, step) => {
            let frequency = pattern[stepIndex];
            if (frequency !== null && frequency !== undefined) {
                synth.triggerAttackRelease(frequency, "4n", time);
            }
            stepIndex++;
            if (stepIndex >= pattern.length) {
                // New period: re-randomize the tone order of each ON cycle.
                pattern = buildPatternPeriod(freq);
                stepIndex = 0;
            }
        }, new Array(STEPS_PER_PERIOD).fill(0));

        this.setState({sequence: newSequence});
        newSequence.set({loop: true});
        newSequence.start(0);
    };

    updatePlayState = (isPlaying, playState) => {
        let {osc, volume} = this.state;
        if (isPlaying) {
            switch (playState) {
                case constants.PLAYER_STATES.PLAY_ACRN:
                    this.setState({playButtonText: constants.STOP_SEQ_TEXT,
                    enableSlider: false});
                    Tone.Master.volume.rampTo(volume, 0.1);
                    this.playAcrn();
                    break;
                case constants.PLAYER_STATES.PLAY_TONE:
                    this.setState({playButtonText: constants.STOP_TONE_TEXT});
                    osc.start();
                    break;
                default:
                    break;

            }
        } else {
            switch (playState) {
                case constants.PLAYER_STATES.PLAY_ACRN:
                    this.setState({playButtonText: constants.PLAY_SEQ_TEXT});
                    let {sequence} = this.state;
                    sequence.cancel();
                    sequence.dispose();
                    this.setState({enableSlider: true});

                    break;
                case constants.PLAYER_STATES.PLAY_TONE:
                    this.setState({playButtonText: constants.PLAY_TONE_TEXT});
                    osc.stop();
                    break;
                default:
                    break;
            }
        }
    };

    // The 4 CR tone frequencies for the current tinnitus frequency, placed
    // equidistantly on a log scale within [0.5*ft, 2*ft] (Tass et al. 2012).
    // Delegates to the shared protocol module so live and export stay in sync.
    generateFreqs = (currentFreq) => {
        return generateFreqs(currentFreq);
    };

    handleRadioChange = (newPlayState) => {
        let {isPlaying, playState} = this.state;
        let buttonText = null;
        let enableSlider = true;

        if (isPlaying) {
            // stop the sound
            this.updatePlayState(false, playState)
        }

        switch (newPlayState) {
            case constants.PLAYER_STATES.PLAY_ACRN:
                if (isPlaying) {
                    enableSlider = false;
                    buttonText = constants.STOP_SEQ_TEXT;
                } else {
                    buttonText = constants.PLAY_SEQ_TEXT;
                }
                break;
            case constants.PLAYER_STATES.PLAY_TONE:
                if (isPlaying) {
                    buttonText = constants.STOP_TONE_TEXT;
                } else {
                    buttonText = constants.PLAY_TONE_TEXT;
                }
                break;
            default:
                break;

        }

        this.setState({
            playState: newPlayState,
            enableSlider: enableSlider,
            playButtonText: buttonText
        });

        if (isPlaying) {
            // start the new sound
            this.updatePlayState(true, newPlayState);
        }
        localStorage.setItem(constants.PLAYER_STATE_KEY, newPlayState);
    };

    handleVolumeChange = (event) => {
        let volume = event - 0.05;
        Tone.Master.volume.rampTo(volume, 0.05);
        this.setState({volume: volume});
        localStorage.setItem(constants.VOLUME_KEY, volume);
    };

    freqSliderTooltip = (props) => {
        const {dragging, index, ...restProps} = props;
        const {freq} = this.state;
        const Handle = Slider.Handle;
        return (
            <Tooltip
                prefixCls="rc-slider-tooltip"
                overlay={freq}
                visible={dragging}
                placement="top"
                key={index}
            >
                <Handle value={freq} {...restProps} />
            </Tooltip>
        );
    };


    render = () => {
        let {freq, enableSlider, volume, playButtonText, playState, isExporting} = this.state;
        return (
            <div className="App">
                <nav className="navbar navbar-default">
                    <div className="container">
                        <div className="navbar-header navbar-right">
                            <ul className="nav navbar-nav">
                                <li><a href="http://github.com/generalfuzz/acrn-react">Source</a></li>
                                <li><a href="http://generalfuzz.net/contact.php">Contact</a></li>
                                <li><a href="http://www.generalfuzz.net">Music</a></li>

                            </ul>
                        </div>
                    </div>
                </nav>
                <div className="container ">
                    <div className="jumbotron bg-info">
                        <h1 className="App-title">ACRN Tinnitus Protocol</h1>
                    </div>
                    <p>This is my attempt at implementing the <a
                        href="https://www.thetinnitusclinic.co.uk/tinnitus-treatment/acoustic-neuromodulation/">Acoustic Coordinated Reset
                        Neuromodulation</a> tinnitus treatment protocol
                        using <a
                            href="https://www.tinnitustalk.com/attachments/tass-et-al_rnn-2012_counteracting-tinnitus-by-acoustic-cr-neuromodulation-pdf.183/">this
                            paper</a> as a guide.</p>
                    <div className="instructions">
                        <ul>
                            <li>First lower the volume on your device, so it is not too loud to start.</li>
                            <li>Start the tone by pressing the "Play Tone" button.</li>
                            <li>Adjust the frequency slider until it matches your tinnitus tone. You can also type in
                                the frequency if you know it already.
                            </li>
                            <li>Adjust the volume until it is a little bit louder than your tinnitus tone.</li>
                            <li>Switch from "Tone" to "Sequence" mode</li>
                        </ul>
                    </div>
                    <p>Inspired by <a
                        href="http://www.tinnitustalk.com/threads/acoustic-cr%C2%AE-neuromodulation-do-it-yourself-guide.1469/">this</a> thread on <a href="http://www.tinnitustalk.com">tinnitustalk.com</a> and <a
                            href="http://www.reddit.com/r/tinnitus/comments/15x99f/recent_tinnitus_study_and_my_attempt_at_utilizing/">this</a> reddit thread.</p>
                    <br/>
                    <div>
                        <ToggleButtonGroup type="radio" name="options"
                                           defaultValue={playState}
                                           onChange={this.handleRadioChange}>
                            <ToggleButton value={constants.PLAYER_STATES.PLAY_TONE}>Tone</ToggleButton>
                            <ToggleButton value={constants.PLAYER_STATES.PLAY_ACRN}>Sequence</ToggleButton>
                        </ToggleButtonGroup>
                        <br/>
                        <br/>
                        <div className='slider'>
                            Frequency
                            <Slider
                                min={constants.MIN_FREQ}
                                max={constants.MAX_FREQ}
                                value={freq}
                                onChange={this.handleFreqChange}
                                handle={this.freqSliderTooltip}
                                disabled={!enableSlider}
                            />
                        </div>
                        <div>
                            <input className='freq-value' onChange={this.handleTextFreqChange} value={freq}/>
                        </div>
                        {playState === constants.PLAYER_STATES.PLAY_ACRN &&
                        <div>
                            <br/>
                            <i>frequencies used in sequence: {this.generateFreqs(freq).map((value, index) => ((index ? ', ' : '') + value))}</i>
                        </div>
                        }
                        <br/>
                        <p>
                            <Button className='btn-success btn-lg'
                                    onClick={this.handleClickPlay}>{playButtonText}</Button>
                            {' '}
                            <Button className='btn-primary btn-lg'
                                    onClick={this.handleExportWav}
                                    disabled={isExporting}>
                                {isExporting ? constants.EXPORT_WAV_BUSY_TEXT : constants.EXPORT_WAV_TEXT}
                            </Button>
                        </p>
                        <div className='slider volume'>
                            Volume
                            <Slider
                                min={-80}
                                max={0}
                                value={volume}
                                onChange={this.handleVolumeChange}
                            />
                        </div>
                    </div>
                </div>
            </div>
        );
    }
}

export default App;
