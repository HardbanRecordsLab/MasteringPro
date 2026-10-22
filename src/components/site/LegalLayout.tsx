import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import SiteFooter from '@/components/site/SiteFooter';
import { BrandMark, Wordmark } from '@/components/Brand';
import { Seo } from '@/components/Seo';
import HrlLangSwitch from '@/lib/hrl/HrlLangSwitch';

// Dokumenty prawne są wspólne dla całej platformy HardbanRecords Lab (jedno źródło na
// hardbanrecordslab.online). Strony /legal/* MasteringPro to tylko skróty dla tej aplikacji.
const SITE = 'https://hardbanrecordslab.online';
export const SHARED_DOCS = [
  { href: `${SITE}/`, label: 'Strona główna HardbanRecords Lab' },
  { href: `${SITE}/terms/`, label: 'Regulamin' },
  { href: `${SITE}/privacy/`, label: 'Polityka prywatności' },
  { href: `${SITE}/cookies/`, label: 'Polityka cookies' },
];

const SharedDocs = () => (
  <div className="space-y-2">
    <p className="text-xs text-muted-foreground">
      MasteringPro jest częścią HardbanRecords Lab (Kamil Skomra). Pełne, wiążące dokumenty:
    </p>
    <div className="flex flex-wrap gap-2">
      {SHARED_DOCS.map((d) => (
        <a
          key={d.href}
          href={d.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-card/60"
        >
          {d.label} ↗
        </a>
      ))}
    </div>
  </div>
);

interface LegalLayoutProps {
  title: string;
  updated: string;
  intro?: string;
  children: ReactNode;
}

const LegalLayout = ({ title, updated, intro, children }: LegalLayoutProps) => (
  <div className="min-h-screen bg-background noise-texture flex flex-col">
    <Seo title={title} description={intro} noIndex />
    <header className="border-b border-border/80 bg-card/40">
      <div className="max-w-3xl mx-auto flex items-center justify-between gap-4 px-4 py-3">
        <Link to="/" className="flex items-center gap-2.5" aria-label="MasteringPro — strona główna">
          <BrandMark className="w-8 h-8" />
          <Wordmark />
        </Link>
        <div className="flex items-center gap-3">
        <HrlLangSwitch />
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} /> Strona główna
        </Link>
        </div>
      </div>
    </header>

    <main className="flex-1 px-4 py-12">
      <article className="max-w-3xl mx-auto space-y-6">
        <div className="space-y-2">
          <div className="text-section-header">Dokument prawny</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold">{title}</h1>
          <p className="text-xs font-mono-display text-muted-foreground">
            Ostatnia aktualizacja: {updated}
          </p>
        </div>
        {intro && <p className="text-muted-foreground leading-relaxed">{intro}</p>}
        <div className="panel p-6 sm:p-8 space-y-6 [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-semibold [&_p]:text-sm [&_p]:text-muted-foreground [&_p]:leading-relaxed [&_li]:text-sm [&_li]:text-muted-foreground [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1.5 [&_section]:space-y-2">
          {children}
        </div>
        <SharedDocs />
      </article>
    </main>

    <SiteFooter />
  </div>
);

export default LegalLayout;
