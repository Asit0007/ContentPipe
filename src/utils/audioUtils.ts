/**
 * Converts raw 24kHz 16-bit mono little-endian PCM data (base64) from Gemini TTS
 * into a valid WAV data URL that HTML5 audio can play natively.
 */
export function pcmBase64ToWavDataUrl(pcmBase64: string, sampleRate = 24000): string {
  try {
    const binaryStr = atob(pcmBase64);
    const pcmLength = binaryStr.length;
    const buffer = new ArrayBuffer(44 + pcmLength);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + pcmLength, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size for PCM
    view.setUint16(20, 1, true); // AudioFormat 1 = PCM
    view.setUint16(22, 1, true); // NumChannels = 1 (mono)
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * 2, true); // ByteRate = SampleRate * NumChannels * BitsPerSample/8
    view.setUint16(32, 2, true); // BlockAlign = NumChannels * BitsPerSample/8
    view.setUint16(34, 16, true); // BitsPerSample = 16

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, pcmLength, true);

    // Write PCM audio data
    const pcmBytes = new Uint8Array(buffer, 44);
    for (let i = 0; i < pcmLength; i++) {
      pcmBytes[i] = binaryStr.charCodeAt(i);
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
  } catch (error) {
    console.error('Error converting PCM to WAV:', error);
    return `data:audio/wav;base64,${pcmBase64}`;
  }
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export function playAudioFromBase64(base64PcmOrWav: string, sampleRate = 24000): HTMLAudioElement {
  let url = base64PcmOrWav;
  if (!base64PcmOrWav.startsWith('blob:') && !base64PcmOrWav.startsWith('data:audio/wav')) {
    url = pcmBase64ToWavDataUrl(base64PcmOrWav, sampleRate);
  }
  const audio = new Audio(url);
  audio.play().catch((e) => console.warn('Audio play exception:', e));
  return audio;
}

// ----------------------------------------------------
// Natural Web Speech Synthesis Engine (100% Reliable Audio)
// ----------------------------------------------------

let sharedAudioContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    sharedAudioContext = new AudioCtx();
  }
  if (sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume().catch(() => {});
  }
  return sharedAudioContext;
}

export function stopAllSpeechAndAudio() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

export interface SpeechOptions {
  voiceGender?: 'male' | 'female' | 'narrator';
  pitch?: number;
  rate?: number;
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: any) => void;
}

export function speakWithBrowserSpeech(text: string, options: SpeechOptions = {}): SpeechSynthesisUtterance | null {
  if (!('speechSynthesis' in window)) {
    console.warn('SpeechSynthesis not supported in this browser environment');
    options.onEnd?.();
    return null;
  }

  window.speechSynthesis.cancel();

  const cleanText = text
    .replace(/[#*`_~]/g, '')
    .replace(/\(.*?\)/g, '')
    .trim();

  if (!cleanText) {
    options.onEnd?.();
    return null;
  }

  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.rate = options.rate || 1.05; // Slightly punchy pace
  utterance.pitch = options.pitch || 1.0;
  utterance.volume = options.volume !== undefined ? options.volume : 1.0;

  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    const englishVoices = voices.filter((v) => v.lang.startsWith('en'));
    const pool = englishVoices.length > 0 ? englishVoices : voices;

    if (options.voiceGender === 'female') {
      const femaleVoice = pool.find((v) =>
        /female|zira|samantha|karen|victoria|moira|google us english|susan/i.test(v.name)
      );
      if (femaleVoice) {
        utterance.voice = femaleVoice;
        utterance.pitch = options.pitch || 1.15;
      }
    } else if (options.voiceGender === 'male') {
      const maleVoice = pool.find((v) =>
        /male|david|daniel|alex|george|tom|aaron|guy|google uk english male/i.test(v.name)
      );
      if (maleVoice) {
        utterance.voice = maleVoice;
        utterance.pitch = options.pitch || 0.95;
      }
    } else {
      const narratorVoice = pool.find((v) => /natural|enhanced|google/i.test(v.name)) || pool[0];
      if (narratorVoice) utterance.voice = narratorVoice;
    }
  }

  utterance.onstart = () => {
    options.onStart?.();
  };

  utterance.onend = () => {
    options.onEnd?.();
  };

  utterance.onerror = (e) => {
    console.warn('Speech synthesis utterance event:', e);
    options.onEnd?.();
  };

  window.speechSynthesis.speak(utterance);
  return utterance;
}

// ----------------------------------------------------
// Real-Time Web Audio SFX Synthesizer
// ----------------------------------------------------
export function playWebAudioSFX(type: 'whoosh' | 'glitch' | 'pop' | 'success' | 'alert' | 'ping') {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    if (type === 'whoosh') {
      // White noise swept bandpass whoosh
      const bufferSize = ctx.sampleRate * 0.35;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
      const whiteNoise = ctx.createBufferSource();
      whiteNoise.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(300, now);
      filter.frequency.exponentialRampToValueAtTime(3500, now + 0.2);
      filter.frequency.exponentialRampToValueAtTime(400, now + 0.35);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      whiteNoise.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      whiteNoise.start(now);
    } else if (type === 'glitch') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(220, now + 0.05);
      osc.frequency.setValueAtTime(1200, now + 0.1);
      osc.frequency.setValueAtTime(110, now + 0.15);

      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'ping' || type === 'pop') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1046.5, now); // C6
      osc.frequency.exponentialRampToValueAtTime(523.25, now + 0.15);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } else if (type === 'success') {
      // Arpeggio chime
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        const time = now + i * 0.08;

        gain.gain.setValueAtTime(0.15, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.3);
      });
    } else if (type === 'alert') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(880, now + 0.1);

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    }
  } catch (e) {
    console.warn('SFX Synth notice:', e);
  }
}
