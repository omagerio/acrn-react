// Minimal PCM -> WAV encoder.
// Takes an AudioBuffer (from OfflineAudioContext rendering) and returns a Blob
// containing a 16-bit PCM WAV file. No external dependencies.

/**
 * Encode an AudioBuffer as a 16-bit PCM WAV Blob.
 * Supports mono or multi-channel (interleaved) output.
 * @param {AudioBuffer} audioBuffer
 * @returns {Blob}
 */
export function audioBufferToWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;

    const bytesPerSample = 2; // 16-bit
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numFrames * blockAlign;
    const bufferSize = 44 + dataSize;

    const arrayBuffer = new ArrayBuffer(bufferSize);
    const view = new DataView(arrayBuffer);

    let offset = 0;

    const writeString = (str) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
        offset += str.length;
    };
    const writeUint32 = (value) => {
        view.setUint32(offset, value, true);
        offset += 4;
    };
    const writeUint16 = (value) => {
        view.setUint16(offset, value, true);
        offset += 2;
    };

    // RIFF chunk descriptor
    writeString('RIFF');
    writeUint32(36 + dataSize);
    writeString('WAVE');

    // fmt sub-chunk
    writeString('fmt ');
    writeUint32(16);          // PCM header size
    writeUint16(1);           // audio format: 1 = PCM
    writeUint16(numChannels);
    writeUint32(sampleRate);
    writeUint32(byteRate);
    writeUint16(blockAlign);
    writeUint16(bytesPerSample * 8); // bits per sample

    // data sub-chunk
    writeString('data');
    writeUint32(dataSize);

    // Gather channel data
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
        channels.push(audioBuffer.getChannelData(ch));
    }

    // Interleave and convert float [-1, 1] to 16-bit PCM
    for (let frame = 0; frame < numFrames; frame++) {
        for (let ch = 0; ch < numChannels; ch++) {
            let sample = channels[ch][frame];
            // clamp
            if (sample > 1) sample = 1;
            else if (sample < -1) sample = -1;
            // scale to int16
            const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            view.setInt16(offset, intSample, true);
            offset += 2;
        }
    }

    return new Blob([view], { type: 'audio/wav' });
}

/**
 * Trigger a browser download of a Blob with the given filename.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    // defer cleanup so the download can start
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 0);
}
