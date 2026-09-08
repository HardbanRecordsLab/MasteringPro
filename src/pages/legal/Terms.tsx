import LegalLayout from '@/components/site/LegalLayout';

const Terms = () => (
  <LegalLayout
    title="Regulamin"
    updated="23.08.2026"
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
      <h2>5. Dostępność</h2>
      <p>
        Nie gwarantujemy nieprzerwanej dostępności usługi. Funkcje mogą być zmieniane, ograniczane
        lub wyłączane, w szczególności w okresie rozwoju aplikacji.
      </p>
    </section>

    <section>
      <h2>6. Odpowiedzialność</h2>
      <p>
        Usługa udostępniana jest „tak jak jest”. W zakresie dozwolonym przez prawo nie odpowiadamy za
        utratę danych, utracone korzyści ani skutki decyzji produkcyjnych podjętych na podstawie
        wyników działania aplikacji.
      </p>
    </section>

    <section>
      <h2>7. Zmiany regulaminu</h2>
      <p>
        Zmiany publikujemy na tej stronie. Korzystanie z usługi po ich opublikowaniu oznacza
        akceptację nowej wersji.
      </p>
    </section>
  </LegalLayout>
);

export default Terms;
