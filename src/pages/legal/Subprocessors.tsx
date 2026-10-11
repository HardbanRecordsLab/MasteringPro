import LegalLayout from '@/components/site/LegalLayout';

const Subprocessors = () => (
  <LegalLayout title="Podmioty przetwarzające" updated="11.10.2026" intro="Dostawcy, którzy pomagają świadczyć MasteringPro.">
    <section>
      <h2>Wykaz</h2>
      <ul>
        <li>Vercel Inc. (USA) — hosting interfejsu.</li>
        <li>Contabo GmbH (Niemcy) — serwer z kontami, limitami i funkcjami AI.</li>
        <li>OpenRouter, Inc. (USA) — dostęp do modeli AI (metryki, ustawienia, wiadomości).</li>
        <li>Stripe Payments Europe, Limited (Irlandia) — płatności za kredyty.</li>
      </ul>
    </section>
    <section>
      <h2>Więcej</h2>
      <p>Pełna lista dla całej platformy i podstawy przekazania danych poza EOG są w Polityce prywatności.</p>
    </section>
  </LegalLayout>
);

export default Subprocessors;
