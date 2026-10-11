import LegalLayout from '@/components/site/LegalLayout';

const Cookies = () => (
  <LegalLayout title="Pliki cookies" updated="11.10.2026" intro="Jakie pliki zapisuje MasteringPro w Twojej przeglądarce.">
    <section>
      <h2>Co zapisujemy</h2>
      <ul>
        <li>Cookie sesji po zalogowaniu (najdłużej 30 dni) oraz presety, historię sesji i ustawienia w pamięci przeglądarki (localStorage).</li>
        <li>Nie używamy cookies analitycznych ani reklamowych, dlatego nie prosimy o zgodę.</li>
      </ul>
    </section>
    <section>
      <h2>Usuwanie</h2>
      <p>Możesz je usunąć w ustawieniach przeglądarki, czyszcząc dane witryny.</p>
    </section>
  </LegalLayout>
);

export default Cookies;
