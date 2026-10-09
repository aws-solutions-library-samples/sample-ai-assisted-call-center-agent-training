import { useRef, useState, useCallback } from 'react';
import { arrayBufferToBase64 } from '../utils/audioUtils';
import { SpeechTurnTracker, type SpeechTiming } from '../utils/speechTurnTracker';

export type { SpeechTiming };

export const useAudioCapture = (onAudioData?: (base64Audio: string) => void) => {
  const [isCapturing, setIsCapturing] = useState(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioProcessorRef = useRef<AudioWorkletNode | null>(null);

  // VAD speech timing tracking
  const speechTrackerRef = useRef(new SpeechTurnTracker());

  const startCapture = useCallback(async () => {
    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });

      mediaStreamRef.current = stream;

      // Setup audio context
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000
      });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);

      // Load AudioWorklet module
      try {
        await audioContext.audioWorklet.addModule('/audio-processor.worklet.js');
      } catch (error) {
        console.error('Failed to load audio worklet module:', error);
        throw new Error('AudioWorklet not supported or failed to load. Please use a modern browser.');
      }

      // Create AudioWorkletNode for audio capture
      const workletNode = new AudioWorkletNode(audioContext, 'audio-capture-processor');
      audioProcessorRef.current = workletNode;

      // Setup message handler to receive processed audio and VAD events from worklet
      workletNode.port.onmessage = (event) => {
        if (!isCapturing && !audioProcessorRef.current) return;

        const { type } = event.data;

        if (type === 'vad') {
          speechTrackerRef.current.onVad(event.data.speaking, Date.now());
          return;
        }

        // PCM audio data
        const { pcmData } = event.data;
        const int16Array = new Int16Array(pcmData);

        // Convert to base64 and send to callback
        if (onAudioData) {
          const base64Audio = arrayBufferToBase64(int16Array.buffer);
          onAudioData(base64Audio);
        }
      };

      // Connect audio graph: MediaStream -> AudioWorklet -> Destination
      source.connect(workletNode);
      workletNode.connect(audioContext.destination);

      setIsCapturing(true);
      return stream;
    } catch (error) {
      console.error('Error starting audio capture:', error);
      return null;
    }
  }, [onAudioData, isCapturing]);

  const stopCapture = useCallback(() => {
    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    // Disconnect and clean up audio processor
    if (audioProcessorRef.current) {
      audioProcessorRef.current.disconnect();
      audioProcessorRef.current.port.close(); // Close MessagePort
      audioProcessorRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Reset VAD timing state
    speechTrackerRef.current.setSessionStart(null);

    setIsCapturing(false);
  }, []);

  const setSessionStart = useCallback((sessionStartMs: number) => {
    speechTrackerRef.current.setSessionStart(sessionStartMs);
  }, []);

  const getAndResetSpeechTiming = useCallback(
    (): SpeechTiming | null => speechTrackerRef.current.getAndReset(Date.now()),
    [],
  );

  return {
    isCapturing,
    startCapture,
    stopCapture,
    setSessionStart,
    getAndResetSpeechTiming,
    mediaStream: mediaStreamRef.current,
  };
};
