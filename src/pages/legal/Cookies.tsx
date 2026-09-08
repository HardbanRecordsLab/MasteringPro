import LegalLayout from '@/components/site/LegalLayout';

const Cookies = () => (
  <LegalLayout
    title="Pliki cookie i pamięć lokalna"
    updated="23.08.2026"
    intro="Jak MasteringPro korzysta z pamięci przeglądarki."
  >
    <section>
      <h2>1. Cookies marketingowe</h2>
      <p>
        Aplikacja nie stosuje plików cookie do reklam ani profilowania i nie osadza zewnętrznych
        skryptów śledzących.
      </p>
    </section>

    <section>
      <h2>2. Pamięć lokalna (localStorage)</h2>
      <p>Do działania aplikacji zapisujemy w Twojej przeglądarce:</p>
      <ul>
        <li>presety noise gate i ustawień AI auto-masteringu,</li>
        <li>historię sesji i migawki ustawień,</li>
        <li>wybrany tryb pracy (Quick / Smart / Pro) oraz postęp przewodnika.</li>
      </ul>
    </section>

    <section>
      <h2>3. Jak usunąć dane</h2>
      <p>
        Wyczyść dane witryny w ustawieniach przeglądarki. Usunięcie skasuje presety i historię sesji
        zapisane na tym urządzeniu.
      </p>
    </section>

    <section>
      <h2>4. Dane techniczne</h2>
      <p>
        Wywołania funkcji AI mogą być rejestrowane w celach bezpieczeństwa i limitowania zapytań —
        szczegóły opisuje Polityka prywatności.
      </p>
    </section>
  </LegalLayout>
);

export default Cookies;
