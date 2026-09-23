import LegalLayout from '@/components/site/LegalLayout';

const Terms = () => (
  <LegalLayout
    title="Regulamin"
    updated="23.09.2026"
    intro="Zasady korzystania z aplikacji MasteringPro."
  >
    <section>
      <h2>1. Zakres usługi</h2>
      <p>
        MasteringPro to narzędzie do masteringu audio działające w przeglądarce, z funkcjami wspieranymi
        przez sztuczną inteligencję. Usługa udostępniana jest w formie, w jakiej istnieje w danym
        momencie.
      </p>
    </section>

    <section>
      <h2>2. Prawa do materiałów</h2>
      <p>
        Wgrywając pliki oświadczasz, że posiadasz do nich prawa lub odpowiednie zgody. Zachowujesz
        pełnię praw do swoich nagrań oraz do plików wyeksportowanych z aplikacji.
      </p>
    </section>

    <section>
      <h2>3. Dozwolone korzystanie</h2>
      <ul>
        <li>Nie obchodź limitów zapytań ani zabezpieczeń usługi.</li>
        <li>Nie używaj aplikacji do treści niezgodnych z prawem.</li>
        <li>Nie podejmuj działań zakłócających stabilność usługi lub jej infrastruktury.</li>
      </ul>
    </section>

    <section>
      <h2>4. Funkcje AI</h2>
      <p>
        Sugestie generowane przez AI mają charakter pomocniczy. Ostateczna ocena brzmienia i decyzja
        o publikacji materiału należy do Ciebie.
      </p>
    </section>

    <section>
      <h2>5. Darmowa konsola i płatne kredyty AI</h2>
      <p>
        Manualna konsola mastering (EQ, kompresja wielopasmowa, limiter, mid/side, saturacja,
        metering, render) jest darmowa i bez limitu, w każdej wersji aplikacji, bez konieczności
        zakładania konta. Płacisz wyłącznie za funkcje AI działające na naszym serwerze — generowanie
        łańcucha mastering, walidację QA, dopasowanie do utworu referencyjnego oraz czat z Copilotem —
        rozliczane w systemie kredytowym.
      </p>
      <p>
        Nowe konto otrzymuje 3 darmowe kredyty AI do wypróbowania. Kolejne kredyty kupuje się w
        pakietach jednorazowych (Starter, Producer, Label, Studio), bez abonamentu — kredyty nie
        wygasają. Płatność realizowana jest wyłącznie za pośrednictwem operatora płatności Stripe;
        nie przechowujemy danych kart płatniczych na naszych serwerach. Aktualne pakiety i ceny
        widoczne są w aplikacji i na stronie cennika przed zakupem.
      </p>
    </section>

    <section>
      <h2>6. Zwroty i odstąpienie od umowy</h2>
      <p>
        Zgodnie z ustawą o prawach konsumenta, konsumentowi przysługuje prawo odstąpienia od umowy
        zawartej na odległość w terminie 14 dni bez podania przyczyny — w zakresie, w jakim dotyczy to
        niewykorzystanych kredytów. Prawo to nie przysługuje w odniesieniu do kredytów już
        wykorzystanych: w chwili uruchomienia przebiegu AI Mastering (co następuje na wyraźne żądanie
        użytkownika, ze świadomością utraty prawa odstąpienia w tym zakresie) usługa cyfrowa zostaje
        wykonana, a odpowiadający jej kredyt nie podlega zwrotowi.
      </p>
      <p>
        W sprawie zwrotu niewykorzystanych kredytów skontaktuj się pod adresem
        contact@hardbanrecordslab.online.
      </p>
    </section>

    <section>
      <h2>7. Dostępność</h2>
      <p>
        Nie gwarantujemy nieprzerwanej dostępności usługi. Funkcje mogą być zmieniane, ograniczane
        lub wyłączane, w szczególności w okresie rozwoju aplikacji.
      </p>
    </section>

    <section>
      <h2>8. Odpowiedzialność</h2>
      <p>
        Usługa udostępniana jest „tak jak jest”. W zakresie dozwolonym przez prawo nie odpowiadamy za
        utratę danych, utracone korzyści ani skutki decyzji produkcyjnych podjętych na podstawie
        wyników działania aplikacji.
      </p>
    </section>

    <section>
      <h2>9. Zmiany regulaminu</h2>
      <p>
        Zmiany publikujemy na tej stronie. Korzystanie z usługi po ich opublikowaniu oznacza
        akceptację nowej wersji.
      </p>
    </section>
  </LegalLayout>
);

export default Terms;
