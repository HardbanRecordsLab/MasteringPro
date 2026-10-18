import LegalLayout from '@/components/site/LegalLayout';

const Terms = () => (
  <LegalLayout title="Regulamin" updated="18.10.2026" intro="Najważniejsze zasady korzystania z MasteringPro.">
    <section>
      <h2>Usługa</h2>
      <p>Konsola masteringu działa w przeglądarce, a Twoje nagrania nie trafiają na nasz serwer. Do wyeksportowania mastera potrzebne jest konto i kredyty; nowe konto dostaje kilka kredytów na start. Asystent AI jest wliczony w cenę utworu.</p>
    </section>
    <section>
      <h2>Kredyty</h2>
      <ul>
        <li>1 kredyt = 1 utwór wyeksportowany jako master. Cały album do 16 utworów to 16 kredytów.</li>
        <li>Ten sam utwór możesz wyeksportować ponownie (poprawki, inne formaty) bez opłaty przez 3 dni od opłacenia. Utwór rozpoznajemy po nazwie, rozmiarze i dacie pliku źródłowego — nie po nagraniu.</li>
        <li>Kupujesz jednorazowy pakiet (1 utwór, 3 utwory, 10 utworów albo album). Bez abonamentu, bez automatycznego odnawiania, kredyty nie wygasają. Cenę i liczbę kredytów widzisz przed zakupem. Płacisz przez Stripe.</li>
        <li>Przez 14 dni możesz odstąpić od zakupu, chyba że na Twoją prośbę kredyty zaczęły być wykorzystywane wcześniej, a utrata tego prawa została przez Ciebie potwierdzona.</li>
        <li>Zasady eksportu na kredyty obowiązują od 18.10.2026.</li>
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
