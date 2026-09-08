import LegalLayout from '@/components/site/LegalLayout';

const rows = [
  {
    name: 'Dostawca hostingu aplikacji',
    purpose: 'Serwowanie strony i zasobów statycznych',
    data: 'Adres IP, dane techniczne żądania',
  },
  {
    name: 'Dostawca backendu (baza, funkcje brzegowe)',
    purpose: 'Obsługa funkcji AI i limitów zapytań',
    data: 'Metryki audio, ustawienia DSP, adres IP, User-Agent',
  },
  {
    name: 'Dostawca modeli AI',
    purpose: 'Generowanie sugestii masteringu i odpowiedzi Copilota',
    data: 'Metryki audio, ustawienia DSP, treść wiadomości',
  },
];

const Subprocessors = () => (
  <LegalLayout
    title="Podprocesorzy"
    updated="23.08.2026"
    intro="Kategorie dostawców wspierających działanie MasteringPro oraz zakres danych, które przetwarzają."
  >
    <section>
      <h2>Wykaz kategorii</h2>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.name} className="inset-well p-4 space-y-1">
            <div className="font-display text-sm font-semibold text-foreground">{r.name}</div>
            <p>Cel: {r.purpose}</p>
            <p>Zakres danych: {r.data}</p>
          </div>
        ))}
      </div>
    </section>

    <section>
      <h2>Aktualizacje wykazu</h2>
      <p>
        Zmiany listy publikujemy na tej stronie. Jeśli potrzebujesz nazw konkretnych podmiotów na
        potrzeby własnej dokumentacji, napisz do nas przez stronę Kontakt.
      </p>
    </section>
  </LegalLayout>
);

export default Subprocessors;
