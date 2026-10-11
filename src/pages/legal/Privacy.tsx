import LegalLayout from '@/components/site/LegalLayout';

const Privacy = () => (
  <LegalLayout title="Polityka prywatności" updated="11.10.2026" intro="Skrót zasad przetwarzania danych w MasteringPro.">
    <section>
      <h2>Administrator</h2>
      <p>Kamil Skomra, prowadzący działalność nierejestrowaną pod marką HardbanRecords Lab. Sprawy danych: legal@hardbanrecordslab.online.</p>
    </section>
    <section>
      <h2>Nagrania</h2>
      <p>Pliki audio są dekodowane i przetwarzane w Twojej przeglądarce. Nie wysyłamy ich na serwer i nie przechowujemy.</p>
    </section>
    <section>
      <h2>Funkcje AI</h2>
      <ul>
        <li>Do AI Auto-Masteringu, dopasowania do referencji i Copilota wysyłamy tylko liczbowe metryki nagrania (np. LUFS, True Peak, dynamika), ustawienia łańcucha i treść wiadomości — nigdy samo nagranie.</li>
        <li>Zapytania obsługuje OpenRouter wyłącznie przez dostawców, którzy nie przechowują i nie trenują na danych.</li>
        <li>Adres IP i identyfikator przeglądarki zapisujemy krótko na potrzeby limitów zapytań.</li>
      </ul>
    </section>
    <section>
      <h2>Konto i płatności</h2>
      <ul>
        <li>Konto (e-mail, hasło w postaci skrótu, saldo kredytów) jest potrzebne tylko do płatnych funkcji AI. Płatności obsługuje Stripe — danych karty nie otrzymujemy.</li>
        <li>Dane konta trzymamy do jego usunięcia, dane rozliczeniowe 5 lat od końca roku podatkowego.</li>
      </ul>
    </section>
    <section>
      <h2>Twoje prawa</h2>
      <p>Dostęp, sprostowanie, usunięcie, ograniczenie, przenoszenie, sprzeciw i skarga do Prezesa UODO. Napisz na legal@hardbanrecordslab.online.</p>
    </section>
  </LegalLayout>
);

export default Privacy;
