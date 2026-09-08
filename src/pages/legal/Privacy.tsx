import LegalLayout from '@/components/site/LegalLayout';

const Privacy = () => (
  <LegalLayout
    title="Polityka prywatności"
    updated="23.08.2026"
    intro="Wyjaśniamy, jakie dane przetwarza MasteringPro, w jakim celu i jakie prawa Ci przysługują."
  >
    <section>
      <h2>1. Kto jest administratorem</h2>
      <p>
        Administratorem danych jest operator aplikacji MasteringPro. Dane kontaktowe znajdziesz na
        stronie Kontakt.
      </p>
    </section>

    <section>
      <h2>2. Twoje pliki audio</h2>
      <p>
        Pliki audio wgrywane do konsoli są dekodowane i przetwarzane lokalnie w Twojej przeglądarce
        (Web Audio API). Nie są przesyłane na nasze serwery ani przechowywane po zamknięciu karty.
      </p>
    </section>

    <section>
      <h2>3. Dane przetwarzane przez funkcje AI</h2>
      <p>
        Gdy korzystasz z AI Auto-Masteringu, dopasowania do referencji lub AI Copilota, na serwer
        wysyłane są wyłącznie liczbowe metryki analizy (np. LUFS, True Peak, dynamika, rozkład
        widma), bieżące ustawienia łańcucha DSP oraz treść Twojej wiadomości do czatu. Nie wysyłamy
        samego nagrania.
      </p>
      <p>
        Do ograniczania nadużyć funkcje AI zapisują tymczasowo adres IP i identyfikator przeglądarki
        (User-Agent) na potrzeby limitów zapytań.
      </p>
    </section>

    <section>
      <h2>4. Dane przechowywane lokalnie</h2>
      <p>
        Presety, historia sesji i ostatnio używane ustawienia zapisywane są w pamięci lokalnej
        Twojej przeglądarki (localStorage). Możesz je w każdej chwili usunąć, czyszcząc dane
        witryny.
      </p>
    </section>

    <section>
      <h2>5. Podstawy i cele przetwarzania</h2>
      <ul>
        <li>Świadczenie usługi na Twoje żądanie (wykonanie umowy).</li>
        <li>Bezpieczeństwo usługi i przeciwdziałanie nadużyciom (uzasadniony interes).</li>
        <li>Obsługa zgłoszeń, które do nas kierujesz.</li>
      </ul>
    </section>

    <section>
      <h2>6. Okres przechowywania</h2>
      <p>
        Dane techniczne używane do limitów zapytań przechowujemy przez krótki czas potrzebny do ich
        egzekwowania. Dane lokalne pozostają na Twoim urządzeniu do czasu ich usunięcia.
      </p>
    </section>

    <section>
      <h2>7. Twoje prawa</h2>
      <p>
        Masz prawo do dostępu do danych, ich sprostowania, usunięcia, ograniczenia przetwarzania,
        sprzeciwu oraz przenoszenia danych, a także do złożenia skargi do organu nadzorczego.
      </p>
    </section>

    <section>
      <h2>8. Zmiany polityki</h2>
      <p>
        Aktualizacje publikujemy na tej stronie wraz ze zmienioną datą aktualizacji. Dalsze
        korzystanie z usługi po zmianie oznacza zapoznanie się z nową wersją.
      </p>
    </section>
  </LegalLayout>
);

export default Privacy;
