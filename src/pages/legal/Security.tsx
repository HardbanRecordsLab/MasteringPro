import LegalLayout from '@/components/site/LegalLayout';

const Security = () => (
  <LegalLayout
    title="Bezpieczeństwo"
    updated="23.08.2026"
    intro="Jak podchodzimy do bezpieczeństwa aplikacji i zgłaszania podatności."
  >
    <section>
      <h2>1. Przetwarzanie audio po stronie klienta</h2>
      <p>
        Dekodowanie, przetwarzanie DSP i render eksportu odbywają się w przeglądarce. Nagrania nie
        opuszczają Twojego urządzenia w ramach normalnego działania aplikacji.
      </p>
    </section>

    <section>
      <h2>2. Funkcje serwerowe</h2>
      <p>
        Funkcje AI działają jako funkcje brzegowe backendu i przyjmują wyłącznie metryki liczbowe
        oraz ustawienia łańcucha. Objęte są limitami zapytań ograniczającymi nadużycia.
      </p>
    </section>

    <section>
      <h2>3. Zgłaszanie podatności</h2>
      <p>
        Jeśli znajdziesz problem bezpieczeństwa, napisz do nas przez stronę Kontakt z opisem kroków
        reprodukcji. Prosimy o nieujawnianie szczegółów publicznie do czasu naprawy.
      </p>
    </section>

    <section>
      <h2>4. Zakres deklaracji</h2>
      <p>
        Strona opisuje praktyki operatora aplikacji. Nie stanowi certyfikatu ani potwierdzenia
        zgodności z konkretnymi normami czy audytami.
      </p>
    </section>
  </LegalLayout>
);

export default Security;
