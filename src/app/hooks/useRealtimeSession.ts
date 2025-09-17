import { useCallback, useRef, useState } from 'react';
import {
  RealtimeSession,
  RealtimeAgent,
  OpenAIRealtimeWebRTC,
} from '@openai/agents/realtime';

import { audioFormatForCodec, applyCodecPreferences } from '../lib/codecUtils';
import { useEvent } from '../contexts/EventContext';
import { useHandleSessionHistory } from './useHandleSessionHistory';
import { SessionStatus } from '../types';
import { normalizeUsage } from '../lib/cost';

export interface RealtimeSessionCallbacks {
  onConnectionChange?: (status: SessionStatus) => void;
  onAgentHandoff?: (agentName: string) => void;
}

export interface ConnectOptions {
  getEphemeralKey: () => Promise<string>;
  initialAgents: RealtimeAgent[];
  audioElement?: HTMLAudioElement;
  extraContext?: Record<string, any>;
  outputGuardrails?: any[];
}

const REALTIME_MODEL = 'gpt-4o-realtime-preview-2025-06-03';

export function useRealtimeSession(callbacks: RealtimeSessionCallbacks = {}) {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const [status, setStatus] = useState<
    SessionStatus
  >('DISCONNECTED');
  const { logClientEvent, logServerEvent, logUsageCost } = useEvent();

  const updateStatus = useCallback(
    (s: SessionStatus) => {
      setStatus(s);
      callbacks.onConnectionChange?.(s);
      logClientEvent({}, s);
    },
    [callbacks, logClientEvent],
  );

  const historyHandlersRef = useHandleSessionHistory();

  const handleTransportEvent = useCallback(
    (event: any) => {
      const historyHandlers = historyHandlersRef.current;
    // Handle additional server events that aren't managed by the session
      switch (event.type) {
        case "conversation.item.input_audio_transcription.completed": {
          historyHandlers.handleTranscriptionCompleted(event);
          break;
        }
        case "response.audio_transcript.done": {
          historyHandlers.handleTranscriptionCompleted(event);
          break;
        }
        case "response.audio_transcript.delta": {
          historyHandlers.handleTranscriptionDelta(event);
          break;
        }
        default: {
          logServerEvent(event);
          break;
        }
      }
    },
    [historyHandlersRef, logServerEvent],
  );

  const codecParamRef = useRef<string>(
    (typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('codec') ?? 'opus')
      : 'opus')
      .toLowerCase(),
  );

  // Wrapper to pass current codec param
  const applyCodec = useCallback(
    (pc: RTCPeerConnection) => applyCodecPreferences(pc, codecParamRef.current),
    [],
  );

  const handleAgentHandoff = useCallback(
    (item: any) => {
      const history = item.context.history;
      const lastMessage = history[history.length - 1];
      const agentName = lastMessage.name.split("transfer_to_")[1];
      callbacks.onAgentHandoff?.(agentName);
    },
    [callbacks],
  );

  const connect = useCallback(
    async ({
      getEphemeralKey,
      initialAgents,
      audioElement,
      extraContext,
      outputGuardrails,
    }: ConnectOptions) => {
      if (sessionRef.current) return; // already connected

      updateStatus('CONNECTING');

      const ek = await getEphemeralKey();
      const rootAgent = initialAgents[0];

      // This lets you use the codec selector in the UI to force narrow-band (8 kHz) codecs to
      //  simulate how the voice agent sounds over a PSTN/SIP phone call.
      const codecParam = codecParamRef.current;
      const audioFormat = audioFormatForCodec(codecParam);

      sessionRef.current = new RealtimeSession(rootAgent, {
        transport: new OpenAIRealtimeWebRTC({
          audioElement,
          // Set preferred codec before offer creation
          changePeerConnection: async (pc: RTCPeerConnection) => {
            applyCodec(pc);
            return pc;
          },
        }),
        model: REALTIME_MODEL,
        config: {
          inputAudioFormat: audioFormat,
          outputAudioFormat: audioFormat,
          inputAudioTranscription: {
            model: 'gpt-4o-mini-transcribe',
          },
        },
        outputGuardrails: outputGuardrails ?? [],
        context: extraContext ?? {},
      });

      const session = sessionRef.current;
      const historyHandlers = historyHandlersRef.current;

      session.on("error", (...args: any[]) => {
        logServerEvent({
          type: "error",
          message: args[0],
        });
      });

      session.on("agent_handoff", handleAgentHandoff);
      session.on("agent_tool_start", historyHandlers.handleAgentToolStart);
      session.on("agent_tool_end", historyHandlers.handleAgentToolEnd);
      session.on("history_updated", historyHandlers.handleHistoryUpdated);
      session.on("history_added", historyHandlers.handleHistoryAdded);
      session.on("guardrail_tripped", historyHandlers.handleGuardrailTripped);
      session.on("transport_event", handleTransportEvent);
      session.on("usage_update", (usage) => {
        logUsageCost({
          model: REALTIME_MODEL,
          source: "realtime",
          usage,
          metadata: {
            requests: usage.requests,
            sessionTotals: normalizeUsage(session.usage),
          },
        });
      });

      await sessionRef.current.connect({ apiKey: ek });
      updateStatus('CONNECTED');
    },
    [applyCodec, callbacks, handleAgentHandoff, handleTransportEvent, historyHandlersRef, logServerEvent, logUsageCost, updateStatus],
  );

  const disconnect = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    updateStatus('DISCONNECTED');
  }, [updateStatus]);

  const assertconnected = () => {
    if (!sessionRef.current) throw new Error('RealtimeSession not connected');
  };

  /* ----------------------- message helpers ------------------------- */

  const interrupt = useCallback(() => {
    sessionRef.current?.interrupt();
  }, []);
  
  const sendUserText = useCallback((text: string) => {
    assertconnected();
    sessionRef.current!.sendMessage(text);
  }, []);

  const sendEvent = useCallback((ev: any) => {
    sessionRef.current?.transport.sendEvent(ev);
  }, []);

  const mute = useCallback((m: boolean) => {
    sessionRef.current?.mute(m);
  }, []);

  const pushToTalkStart = useCallback(() => {
    if (!sessionRef.current) return;
    sessionRef.current.transport.sendEvent({ type: 'input_audio_buffer.clear' } as any);
  }, []);

  const pushToTalkStop = useCallback(() => {
    if (!sessionRef.current) return;
    sessionRef.current.transport.sendEvent({ type: 'input_audio_buffer.commit' } as any);
    sessionRef.current.transport.sendEvent({ type: 'response.create' } as any);
  }, []);

  return {
    status,
    connect,
    disconnect,
    sendUserText,
    sendEvent,
    mute,
    pushToTalkStart,
    pushToTalkStop,
    interrupt,
  } as const;
}
