import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Send, Loader2, Undo2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAudio, type ProcessingParams } from '@/contexts/AudioContext';
import { analyzeAudio, type AudioMetrics } from '@/lib/audioAnalysis';
import { invokeAI } from '@/lib/aiApi';
import { toast } from '@/hooks/use-toast';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  changes?: string[];
}

const RANGES: Partial<Record<keyof ProcessingParams, [number, number]>> = {
  inputGain: [-24, 24],
  compThreshold: [-60, 0],
  compRatio: [1, 8],
  compAttack: [1, 100],
  compRelease: [20, 1000],
  compKnee: [0, 20],
  compMakeup: [0, 12],
  saturation: [0, 60],
  stereoWidth: [50, 150],
  limiterCeiling: [-3, -0.3],
  limiterRelease: [20, 500],
  gateThreshold: [-80, 0],
  gateRange: [-60, 0],
  gateAttack: [0.1, 50],
  gateHold: [0, 200],
  gateRelease: [10, 1000],
  msMidLow: [-9, 9], msMidMid: [-9, 9], msMidHigh: [-9, 9],
  msSideLow: [-9, 9], msSideMid: [-9, 9], msSideHigh: [-9, 9],
};

const clamp = (v: number, [min, max]: [number, number]) => Math.min(max, Math.max(min, v));

/** Sanitize an AI patch so it can never push the chain out of safe bounds. */
function sanitizePatch(patch: any, current: ProcessingParams): Partial<ProcessingParams> {
  const out: any = {};
  if (!patch || typeof patch !== 'object') return out;

  for (const [key, value] of Object.entries(patch)) {
    if (!(key in current)) continue;
    if (key === 'eqBands') {
      if (!Array.isArray(value) || value.length !== 5) continue;
      out.eqBands = value.map((b: any, i: number) => ({
        freq: Number.isFinite(b?.freq) ? clamp(Number(b.freq), [20, 20000]) : current.eqBands[i].freq,
        gain: Number.isFinite(b?.gain) ? clamp(Number(b.gain), [-12, 6]) : 0,
        q: Number.isFinite(b?.q) ? clamp(Number(b.q), [0.1, 10]) : current.eqBands[i].q,
        type: current.eqBands[i].type,
      }));
      continue;
    }
    if (typeof (current as any)[key] === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
      continue;
    }
    if (typeof (current as any)[key] === 'number' && Number.isFinite(Number(value))) {
      const range = RANGES[key as keyof ProcessingParams];
      out[key] = range ? clamp(Number(value), range) : Number(value);
    }
  }
  return out;
}

const QUICK_PROMPTS = [
  'Za dużo basu, popraw',
  'Wokal ginie w miksie',
  'Zrób głośniej na Spotify',
  'Brzmi ostro i męcząco',
];

const AICopilotChat: React.FC = () => {
  const { state, processing, setProcessing } = useAudio();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [prevParams, setPrevParams] = useState<ProcessingParams | null>(null);
  const metricsRef = useRef<AudioMetrics | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    metricsRef.current = null;
  }, [state.audioBuffer]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      if (!metricsRef.current && state.audioBuffer) {
        metricsRef.current = analyzeAudio(state.audioBuffer);
      }

      const { data, error } = await invokeAI('ai-copilot', {
        messages: nextMessages.map(m => ({ role: m.role, content: m.content })),
        metrics: metricsRef.current,
        params: processing,
        platform: 'spotify',
      });

      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      const patch = sanitizePatch((data as any)?.patch, processing);
      const changed = Object.keys(patch).length > 0;

      if (changed) {
        setPrevParams(processing);
        setProcessing(prev => ({ ...prev, ...patch }));
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: (data as any)?.reply || 'Gotowe.',
        changes: changed ? ((data as any)?.changes ?? []) : [],
      }]);
    } catch (e: any) {
      const msg = String(e?.message || e);
      toast({
        title: 'Copilot niedostępny',
        description: msg.includes('429') ? 'Limit zapytań — spróbuj za chwilę.'
          : msg.includes('402') ? 'Wyczerpane środki AI.' : msg.slice(0, 160),
        variant: 'destructive',
      });
      setMessages(prev => [...prev, { role: 'assistant', content: 'Nie udało się przetworzyć zapytania.' }]);
    } finally {
      setLoading(false);
    }
  }, [messages, loading, processing, setProcessing, state.audioBuffer]);

  return (
    <div className="panel p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">AI Copilot</h3>
        </div>
        {prevParams && (
          <Button
            variant="ghost" size="sm" className="h-7 gap-1 text-xs"
            onClick={() => { setProcessing(prevParams); setPrevParams(null); }}
          >
            <Undo2 className="w-3 h-3" /> Cofnij
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="h-56 overflow-y-auto space-y-2 pr-1">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Opisz co słyszysz, a ja zmienię łańcuch masteringowy. Np. „za dużo basu, popraw”.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`text-xs rounded-md px-2.5 py-2 leading-relaxed ${
              m.role === 'user'
                ? 'bg-primary/10 text-foreground ml-6'
                : 'bg-muted/50 text-foreground mr-6'
            }`}
          >
            <p className="whitespace-pre-wrap">{m.content}</p>
            {m.changes && m.changes.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 font-mono text-[10px] text-primary">
                {m.changes.map((c, j) => <li key={j}>› {c}</li>)}
              </ul>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Copilot analizuje…
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {QUICK_PROMPTS.map(p => (
          <button
            key={p}
            onClick={() => send(p)}
            disabled={loading}
            className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-40"
          >
            <Sparkles className="w-2.5 h-2.5 inline mr-1" />{p}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="flex items-center gap-2"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Napisz co poprawić…"
          className="h-8 text-xs"
          aria-label="Wiadomość do AI Copilot"
          disabled={loading}
        />
        <Button type="submit" size="sm" className="h-8 px-3" disabled={loading || !input.trim()} aria-label="Wyślij">
          <Send className="w-3.5 h-3.5" />
        </Button>
      </form>
    </div>
  );
};

export default AICopilotChat;
