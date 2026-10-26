// Crée la réservation directe dans SuperHote (API publique) :
// elle bloque les nuits sur Airbnb/Booking, apparaît dans l'appli avec le voyageur, et déclenche messages, tâches et codes.
export async function creerResaSuperHote(l: any, r: any) {
  const base = (Deno.env.get("SUPERHOTE_API_URL") ?? "").replace(/\/$/, "");
  const key = Deno.env.get("SUPERHOTE_API_KEY");
  if (!base || !key) throw new Error("SuperHote non configuré (SUPERHOTE_API_URL / SUPERHOTE_API_KEY)");
  if (!l.superhote_id) throw new Error(`Logement ${l.nom} non relié à SuperHote (superhote_id vide)`);

  const corps = {
    rental_id: l.superhote_id,
    checkin: r.arrivee,
    checkout: r.depart,
    adults_count: r.adultes,
    children_count: r.enfants ?? 0,
    status: "CONFIRMED",
    payment_status: "PAID",
    currency: "EUR",
    nights_price: Number(r.montant_nuits),
    cleaning_fee: Number(r.montant_menage ?? 0),
    city_tax: Number(r.montant_taxe ?? 0),
    external_reference: r.ref,
    time_in: l.arrivee_heure ?? undefined,
    time_out: l.depart_heure ?? undefined,
    private_notes: `Réservation directe site D and Sons – ${r.ref} – payée ${Number(r.montant_total).toFixed(2)} € via Stripe. Caution 500 € par empreinte bancaire.`,
    guest: {
      first_name: r.prenom,
      last_name: r.nom,
      email: r.email,
      phone: r.telephone,
      address: r.adresse ?? undefined,
      postal_code: r.code_postal ?? undefined,
      city: r.ville ?? undefined,
      country_code: (r.pays ?? "FR").slice(0, 2).toUpperCase(),
    },
  };

  const res = await fetch(`${base}/reservations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(corps),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`SuperHote ${res.status} : ${txt.slice(0, 300)}`);
  try {
    const j = JSON.parse(txt);
    return (j.result?.id ?? j.data?.id ?? j.id ?? j.reservation?.id ?? null) as number | null;
  } catch {
    return null;
  }
}
