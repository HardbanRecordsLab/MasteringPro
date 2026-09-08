import LegalLayout from '@/components/site/LegalLayout';

const Contact = () => (
  <LegalLayout
    title="Kontakt"
    updated="23.08.2026"
    intro="Pytania o produkt, prywatność lub bezpieczeństwo kierujesz w jedno miejsce."
  >
    <section>
      <h2>Dane kontaktowe</h2>
      <p>
        Uzupełnij poniższe pola danymi operatora aplikacji przed publicznym uruchomieniem usługi.
      </p>
      <ul>
        <li>Nazwa operatora: [do uzupełnienia]</li>
        <li>Adres: [do uzupełnienia]</li>
        <li>E-mail ogólny: [do uzupełnienia]</li>
        <li>E-mail ds. prywatności: [do uzupełnienia]</li>
        <li>E-mail ds. bezpieczeństwa: [do uzupełnienia]</li>
      </ul>
    </section>

    <section>
      <h2>Czas odpowiedzi</h2>
      <p>
        Na wiadomości staramy się odpowiadać w dni robocze. Zgłoszenia bezpieczeństwa traktujemy
        priorytetowo.
      </p>
    </section>
  </LegalLayout>
);

export default Contact;
