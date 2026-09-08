import { Link } from 'react-router-dom';
import { BrandMark, Wordmark } from '@/components/Brand';

const legal = [
  { to: '/legal/privacy', label: 'Polityka prywatności' },
  { to: '/legal/terms', label: 'Regulamin' },
  { to: '/legal/cookies', label: 'Pliki cookie' },
  { to: '/legal/security', label: 'Bezpieczeństwo' },
  { to: '/legal/subprocessors', label: 'Podprocesorzy' },
  { to: '/legal/contact', label: 'Kontakt' },
];

const SiteFooter = () => (
  <footer className="border-t border-border/80 bg-card/30 px-4 py-10">
    <div className="max-w-6xl mx-auto grid gap-8 sm:grid-cols-3">
      <div className="space-y-3">
        <Link to="/" className="flex items-center gap-2.5" aria-label="MasteringPro — strona główna">
          <BrandMark className="w-8 h-8" />
          <Wordmark />
        </Link>
        <p className="text-sm text-muted-foreground max-w-xs">
          Profesjonalny mastering audio z AI, działający w przeglądarce.
        </p>
      </div>

      <nav className="space-y-2">
        <div className="text-section-header">Produkt</div>
        <ul className="space-y-1.5">
          <li>
            <Link to="/app" className="text-sm text-muted-foreground hover:text-foreground">
              Konsola masteringu
            </Link>
          </li>
          <li>
            <Link to="/#features" className="text-sm text-muted-foreground hover:text-foreground">
              Funkcje
            </Link>
          </li>
          <li>
            <Link to="/#how" className="text-sm text-muted-foreground hover:text-foreground">
              Jak to działa
            </Link>
          </li>
        </ul>
      </nav>

      <nav className="space-y-2">
        <div className="text-section-header">Dokumenty</div>
        <ul className="space-y-1.5">
          {legal.map((l) => (
            <li key={l.to}>
              <Link to={l.to} className="text-sm text-muted-foreground hover:text-foreground">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>

    <div className="max-w-6xl mx-auto mt-8 pt-6 border-t border-border/60 text-xs text-muted-foreground">
      © {new Date().getFullYear()} MasteringPro · Hardban Records Lab. Wszelkie prawa zastrzeżone.
    </div>
  </footer>
);

export default SiteFooter;
