import LegalLayout from '@/components/site/LegalLayout';

const Terms = () => (
  <LegalLayout title="Regulamin" updated="11.10.2026" intro="Najważniejsze zasady korzystania z MasteringPro.">
    <section>
      <h2>Usługa</h2>
      <p>Ręczna konsola masteringu jest bezpłatna i działa bez konta. Funkcje AI wymagają konta i kredytów.</p>
    </section>
    <section>
      <h2>Kredyty AI</h2>
      <ul>
        <li>Cenę i liczbę kredytów widzisz przed zakupem. Płacisz przez Stripe.</li>
        <li>Przez 14 dni możesz odstąpić od zakupu, chyba że na Twoją prośbę kredyty zaczęły być wykorzystywane wcześniej, a utrata tego prawa została przez Ciebie potwierdzona.</li>
      </ul>
    </section>
    <section>
      <h2>Wyniki AI</h2>
      <p>Ustawienia i podpowiedzi AI są propozycjami — przed publikacją utworu sprawdź efekt na odsłuchu.</p>
    </section>
    <section>
      <h2>Reklamacje</h2>
      <p>legal@hardbanrecordslab.online — odpowiadamy w ciągu 14 dni.</p>
    </section>
  </LegalLayout>
);

export default Terms;
