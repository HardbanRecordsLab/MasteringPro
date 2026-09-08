import type { UIMode } from '@/contexts/UIModeContext';

export type TourStep = {
  label: string;
  hint: string;
  selector: string;
  requiresAudio?: boolean;
};

export const STEPS_BY_MODE: Record<UIMode, TourStep[]> = {
  quick: [
    { label: 'Wgraj utwór', hint: 'Przeciągnij plik lub kliknij, aby wybrać.', selector: '[data-tour="upload"]' },
    { label: 'Master jednym kliknięciem', hint: 'AI zanalizuje, wyrenderuje i pobierze gotowy plik.', selector: '[data-tour="one-click"]', requiresAudio: true },
  ],
  smart: [
    { label: 'Wgraj utwór', hint: 'Wczytaj plik audio, aby zacząć.', selector: '[data-tour="upload"]' },
    { label: 'Sprawdź Quality Score', hint: 'Zobacz jak brzmi materiał źródłowy.', selector: '[data-tour="quality"]', requiresAudio: true },
    { label: 'Zastosuj AI Preset', hint: 'Wybierz styl / platformę — AI ustawi łańcuch.', selector: '[data-tour="ai-presets"]', requiresAudio: true },
    { label: 'Napraw problemy (AI Fix)', hint: 'Jednym kliknięciem popraw wykryte usterki.', selector: '[data-tour="ai-fix"]', requiresAudio: true },
    { label: 'Eksportuj master', hint: 'Wybierz format i pobierz gotowy plik.', selector: '[data-tour="export"]', requiresAudio: true },
  ],
  pro: [
    { label: 'Wgraj utwór', hint: 'Wczytaj plik audio, aby zacząć.', selector: '[data-tour="upload"]' },
    { label: 'Sprawdź Quality Score', hint: 'Metryki: LUFS, TP, DR, korelacja.', selector: '[data-tour="quality"]', requiresAudio: true },
    { label: 'Referencja (opcjonalnie)', hint: 'Dopasuj brzmienie do wybranego utworu.', selector: '[data-tour="reference"]', requiresAudio: true },
    { label: 'Dostrój DSP', hint: 'EQ, kompresja, saturacja, stereo, limiter — w zakładkach.', selector: '[data-tour="dsp-tabs"]', requiresAudio: true },
    { label: 'Eksportuj master', hint: 'Wybierz format, platformę i pobierz.', selector: '[data-tour="export"]', requiresAudio: true },
  ],
};
