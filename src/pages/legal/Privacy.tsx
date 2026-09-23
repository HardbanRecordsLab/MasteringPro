import LegalLayout from '@/components/site/LegalLayout';

const Privacy = () => (
  <LegalLayout
    title="Polityka prywatności"
    updated="23.09.2026"
    intro="Wyjaśniamy, jakie dane przetwarza MasteringPro, w jakim celu i jakie prawa Ci przysługują."
  >
    <section>
      <h2>1. Kto jest administratorem</h2>
      <p>
        Administratorem danych jest [DANE PODMIOTU: Kamil Skomra, prowadzący jednoosobową
        działalność gospodarczą pod firmą HardbanRecords Lab, NIP: [NIP], REGON: [REGON], adres
        siedziby: [ADRES]]. Kontakt: contact@hardbanrecordslab.online.
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
      <h2>4. Konto i płatności</h2>
      <p>
        Jeśli założysz konto: adres e-mail, hasło (przechowywane w formie zahaszowanej) oraz saldo
        kredytów AI. Konto nie jest wymagane do korzystania z darmowej, manualnej konsoli mastering —
        zakładasz je wyłącznie, jeśli chcesz korzystać z płatnych funkcji AI.
      </p>
      <p>
        Przy zakupie pakietu kredytów przekierowujemy Cię do checkoutu Stripe. Nie przechowujemy
        danych Twojej karty płatniczej — przetwarza je wyłącznie Stripe, zgodnie z jego własną
        polityką prywatności i standardem PCI DSS. Po stronie MasteringPro zapisujemy jedynie: który
        pakiet kupiłeś, ile kredytów doliczono i kiedy — do historii zakupów i rozliczeń.
      </p>
    </section>

    <section>
      <h2>5. Dane przechowywane lokalnie</h2>
      <p>
        Presety, historia sesji i ostatnio używane ustawienia zapisywane są w pamięci lokalnej
        Twojej przeglądarki (localStorage). Możesz je w każdej chwili usunąć, czyszcząc dane
        witryny.
      </p>
    </section>

    <section>
      <h2>6. Podstawy i cele przetwarzania</h2>
      <ul>
        <li>Świadczenie usługi na Twoje żądanie (wykonanie umowy) — w tym obsługa konta i zakupu kredytów.</li>
        <li>Rozliczenia i dokumenty księgowe (obowiązek prawny).</li>
        <li>Bezpieczeństwo usługi i przeciwdziałanie nadużyciom (uzasadniony interes).</li>
        <li>Obsługa zgłoszeń, które do nas kierujesz.</li>
      </ul>
    </section>

    <section>
      <h2>7. Okres przechowywania</h2>
      <p>
        Dane konta i historii zakupów przechowujemy przez czas posiadania konta oraz — w zakresie
        danych rozliczeniowych — przez okres wymagany przepisami o rachunkowości (co do zasady 5 lat
        od końca roku transakcji). Dane techniczne używane do limitów zapytań przechowujemy przez
        krótki czas potrzebny do ich egzekwowania. Dane lokalne pozostają na Twoim urządzeniu do czasu
        ich usunięcia.
      </p>
    </section>

    <section>
      <h2>8. Twoje prawa</h2>
      <p>
        Masz prawo do dostępu do danych, ich sprostowania, usunięcia, ograniczenia przetwarzania,
        sprzeciwu oraz przenoszenia danych, a także do złożenia skargi do Prezesa Urzędu Ochrony
        Danych Osobowych (ul. Stawki 2, 00-193 Warszawa). Kontakt w tych sprawach:
        contact@hardbanrecordslab.online.
      </p>
    </section>

    <section>
      <h2>9. Zmiany polityki</h2>
      <p>
        Aktualizacje publikujemy na tej stronie wraz ze zmienioną datą aktualizacji. Dalsze
        korzystanie z usługi po zmianie oznacza zapoznanie się z nową wersją.
      </p>
    </section>
  </LegalLayout>
);

export default Privacy;
