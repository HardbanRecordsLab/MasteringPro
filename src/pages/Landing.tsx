import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  AudioWaveform,
  Sparkles,
  Gauge,
  SlidersHorizontal,
  Download,
  MessageSquare,
  ShieldCheck,
  Zap,
  Wrench,
  Layers,
  Disc3,
  BadgeCheck,
  Radio,
  Equal,
} from 'lucide-react';
import SiteFooter from '@/components/site/SiteFooter';
import { BrandMark, Wordmark } from '@/components/Brand';
import { Seo } from '@/components/Seo';
import HrlLangSwitch from '@/lib/hrl/HrlLangSwitch';

const features = [
  {
    icon: Sparkles,
    title: 'AI Auto-Mastering',
    desc: 'Wielostopniowy pipeline: analiza, propozycja łańcucha DSP i walidacja QA pod wybraną platformę i styl.',
  },
  {
    icon: MessageSquare,
    title: 'AI Copilot',
    desc: 'Piszesz „za dużo basu” — Copilot zmienia parametry, pokazuje listę zmian i pozwala cofnąć jednym kliknięciem.',
  },
  {
    icon: Gauge,
    title: 'Metering BS.1770-4',
    desc: 'Zgodne z normą LUFS (gated), LRA wg EBU R128 i True Peak z 4x oversamplingiem — bez przybliżeń RMS.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Pełny łańcuch Pro',
    desc: 'Gate z envelope followerem, parametryczny i Mid/Side EQ, kompresja dynamiki, saturacja, szerokość stereo, limiter true-peak z lookaheadem.',
  },
  {
    icon: Download,
    title: 'Eksport studyjny',
    desc: 'WAV 16/24/32-bit, dithering TPDF lub noise-shaped. Render offline z zamkniętą pętlą głośności — trafia w cel platformy z dokładnością ±0.3 LU, sufit dBTP gwarantowany.',
  },
  {
    icon: Zap,
    title: 'Quick · Smart · Pro',
    desc: 'Jeden klik do gotowego mastera albo pełna kontrola nad każdym pasmem. Tryb wybierasz sam.',
  },
  {
    icon: Wrench,
    title: 'Restauracja nagrań',
    desc: 'Usuwa trzaski, brum sieciowy i szum, odtwarza ścięte szczyty (declip). Najpierw diagnoza z liczbami, potem Ty decydujesz, co naprawić.',
  },
  {
    icon: Layers,
    title: 'Multiband 2.0',
    desc: '3–6 pasm z zwrotnicą Linkwitz-Riley, rzeczywistymi czasami ataku i release oraz auto-dostrajaniem do materiału. Tryb delta i solo pasma.',
  },
  {
    icon: Equal,
    title: 'Dopasowanie do referencji',
    desc: 'Barwa, szerokość stereo i dynamika pasm dopasowane do wybranego utworu — filtrem minimalnofazowym, bez „podbijania EQ na oko”.',
  },
  {
    icon: Disc3,
    title: 'Tryb albumu',
    desc: 'Do 16 utworów: spójna głośność i barwa, kolejność (flow / rising / arc), przerwy, fade’y, arkusz CUE i raport w jednym ZIP-ie.',
  },
  {
    icon: Radio,
    title: 'Delivery Check',
    desc: 'Koduje master do AAC, Opus i MP3 jak serwisy streamingowe i mierzy true peak PO transkodowaniu. Sprawdza też, czy bas przetrwa mono.',
  },
  {
    icon: BadgeCheck,
    title: 'Paszport mastera',
    desc: 'Podpisany cyfrowo (Ed25519) raport głośności i true peaku konkretnego pliku, plus ISRC i metadane wpisane w WAV, FLAC, MP3 i AIFF.',
  },
];

const packs = [
  { n: '1 utwór', p: '$7.99', per: '$7.99 / utwór', note: 'Jeden master, bez zobowiązań.' },
  { n: '3 utwory', p: '$19.99', per: '$6.66 / utwór', note: 'Singiel z remiksami albo mała EP.' },
  { n: '10 utworów', p: '$49', per: '$4.90 / utwór', note: 'EP lub kilka singli.', hot: true },
  { n: 'Cały album', p: '$64.99', per: 'do 16 utworów · $4.06 / utwór', note: 'Z trybem albumu: spójność całości.' },
];

const steps = [
  { n: '01', t: 'Wrzuć utwór', d: 'WAV, MP3 lub FLAC — plik zostaje w Twojej przeglądarce.' },
  { n: '02', t: 'Analiza i AI', d: 'Silnik mierzy LUFS, True Peak, dynamikę i widmo, po czym proponuje łańcuch.' },
  { n: '03', t: 'Porównaj A/B', d: 'Przełączasz przed/po w locie — wyrównane głośnościowo, więc słyszysz przetwarzanie, nie poziom.' },
  { n: '04', t: 'Eksportuj', d: 'Render offline w tym samym łańcuchu, jaki słyszysz — z kompensacją latencji i dopasowaniem do celu platformy.' },
];

const Landing = () => (
  <div className="min-h-screen bg-background noise-texture flex flex-col">
    <Seo
      path="/"
      description="Studyjny mastering audio z AI, w przeglądarce: metering BS.1770-4, pełny łańcuch DSP (EQ, kompresja multiband, mid/side, saturacja, limiter lookahead) i AI Copilot, restauracja nagrań, tryb albumu i kontrola dostawy do streamingu. Pliki nie opuszczają Twojej przeglądarki. 3 utwory gratis, potem od $7.99 — bez abonamentu."
    />
    <header className="border-b border-border/80 bg-card/40 backdrop-blur">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 px-4 py-3">
        <Link to="/" className="flex items-center gap-2.5" aria-label="MasteringPro — strona główna">
          <BrandMark className="w-8 h-8" />
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          <a
            href="#features"
            className="hidden sm:inline-flex text-xs font-medium text-muted-foreground hover:text-foreground px-3 py-2"
          >
            Funkcje
          </a>
          <a
            href="#pricing"
            className="hidden sm:inline-flex text-xs font-medium text-muted-foreground hover:text-foreground px-3 py-2"
          >
            Cennik
          </a>
          <a
            href="#how"
            className="hidden sm:inline-flex text-xs font-medium text-muted-foreground hover:text-foreground px-3 py-2"
          >
            Jak to działa
          </a>
          <HrlLangSwitch />
          <Button asChild size="sm">
            <Link to="/app">Otwórz konsolę</Link>
          </Button>
        </nav>
      </div>
    </header>

    <main className="flex-1">
      {/* Hero */}
      <section className="px-4 pt-14 pb-16 sm:pt-24 sm:pb-24">
        <div className="max-w-6xl mx-auto grid lg:grid-cols-12 gap-8 items-center">
          <div className="lg:col-span-7 space-y-6">
            <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary panel px-3 py-1.5">
              <Sparkles className="w-3 h-3" strokeWidth={1.5} /> AI mastering w przeglądarce
            </span>
            <h1 className="font-display text-4xl sm:text-6xl font-extrabold leading-[1.05] tracking-tight">
              Studyjny mastering
              <span className="block text-primary">bez studia.</span>
            </h1>
            <p className="text-base sm:text-lg text-muted-foreground max-w-xl leading-relaxed">
              MasteringPro analizuje Twój utwór zgodnie z normą BS.1770-4, buduje pełny łańcuch DSP
              i eksportuje master gotowy na Spotify, Apple Music czy klub — wszystko lokalnie,
              w jednej karcie przeglądarki.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="gap-2">
                <Link to="/app">
                  <Zap className="w-4 h-4" strokeWidth={1.5} /> Zacznij — 3 utwory gratis
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="#features">Zobacz funkcje</a>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-2">
              <ShieldCheck className="w-3.5 h-3.5 text-primary" strokeWidth={1.5} />
              Pliki audio przetwarzane są w przeglądarce — nie wysyłamy ich na serwer.
            </p>
          </div>

          <div className="lg:col-span-5">
            <div className="panel p-5 space-y-4">
              <div className="text-section-header">Live metering</div>
              <div className="inset-well p-4 space-y-3">
                {[
                  { l: 'Integrated LUFS', v: '-14.0' },
                  { l: 'True Peak', v: '-1.0 dBTP' },
                  { l: 'LRA', v: '7.2 LU' },
                  { l: 'Dynamic Range', v: 'DR 9' },
                ].map((m) => (
                  <div key={m.l} className="flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {m.l}
                    </span>
                    <span className="font-mono-display text-sm text-primary">{m.v}</span>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-12 gap-1 items-end h-20">
                {Array.from({ length: 36 }).map((_, i) => (
                  <span
                    key={i}
                    className="col-span-1 rounded-sm bg-primary/70"
                    style={{ height: `${20 + Math.abs(Math.sin(i * 1.7)) * 70}%` }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="px-4 py-16 border-t border-border/60">
        <div className="max-w-6xl mx-auto space-y-8">
          <div className="max-w-2xl space-y-3">
            <div className="text-section-header">Funkcje</div>
            <h2 className="font-display text-3xl sm:text-4xl font-bold">
              Wszystko, czego potrzebuje master
            </h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map((f) => (
              <article key={f.title} className="panel tile-hover p-5 space-y-3">
                <span className="w-9 h-9 rounded-md inset-well grid place-items-center">
                  <f.icon className="w-4 h-4 text-primary" strokeWidth={1.5} />
                </span>
                <h3 className="font-display text-base font-semibold">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="px-4 py-16 border-t border-border/60">
        <div className="max-w-6xl mx-auto space-y-8">
          <div className="max-w-2xl space-y-3">
            <div className="text-section-header">Jak to działa</div>
            <h2 className="font-display text-3xl sm:text-4xl font-bold">Cztery kroki do mastera</h2>
          </div>
          <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {steps.map((s) => (
              <li key={s.n} className="panel p-5 space-y-2">
                <span className="font-mono-display text-xs text-primary">{s.n}</span>
                <h3 className="font-display text-base font-semibold">{s.t}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-4 py-16 border-t border-border/60">
        <div className="max-w-6xl mx-auto space-y-8">
          <div className="max-w-2xl space-y-3">
            <div className="text-section-header">Cennik</div>
            <h2 className="font-display text-3xl sm:text-4xl font-bold">Płacisz za utwór. Bez abonamentu.</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Jedna usługa dla każdego — te same funkcje w każdym pakiecie, różni się tylko liczba utworów.
              Kredyty nie wygasają, nic się nie odnawia samo, a trzy pierwsze utwory są gratis (bez karty).
              Poprawki i inne formaty tego samego utworu przez 3 dni — bez opłaty.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {packs.map((k) => (
              <article key={k.n} className={`panel p-5 space-y-2 ${k.hot ? 'ring-1 ring-primary/60' : ''}`}>
                <h3 className="font-display text-base font-semibold">{k.n}</h3>
                <div className="font-mono-display text-3xl text-primary">{k.p}</div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{k.per}</div>
                <p className="text-sm text-muted-foreground leading-relaxed">{k.note}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 py-16 border-t border-border/60">
        <div className="max-w-4xl mx-auto panel p-8 sm:p-12 text-center space-y-5">
          <h2 className="font-display text-3xl sm:text-4xl font-bold">
            Zmasteruj pierwszy utwór w minutę
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Bez instalacji, bez konta. Otwórz konsolę, wrzuć plik i posłuchaj różnicy.
          </p>
          <Button asChild size="lg" className="gap-2">
            <Link to="/app">
              <AudioWaveform className="w-4 h-4" strokeWidth={1.5} /> Otwórz konsolę
            </Link>
          </Button>
        </div>
      </section>
    </main>

    <SiteFooter />
  </div>
);

export default Landing;
