// Tâche quotidienne (pg_cron) : empreintes de caution
//  - la veille de l'arrivée : bloque l'empreinte sur la carte enregistrée
//  - séjour long : renouvelle l'empreinte avant ses 7 jours de validité Stripe
//  - 48 h après le départ : libère l'empreinte si l'hôte ne l'a pas encaissée dans Stripe
import { admin, iso, json } from "../_shared/commun.ts";
import { bloquerEmpreinte, stripe } from "../_shared/stripe.ts";
import { envoyerEmail, eur } from "../_shared/email.ts";

const jour = (decalage: number) => iso(new Date(Date.now() + decalage * 86400000));

Deno.serve(async () => {
  const sb = admin();
  const { data: pRows } = await sb.from("dsons_parametres").select("cle, valeur");
  const p = Object.fromEntries((pRows ?? []).map((x: any) => [x.cle, x.valeur]));
  const { data: logements } = await sb.from("dsons_logements").select("slug, nom");
  const nomDe = (slug: string) => logements?.find((l: any) => l.slug === slug)?.nom ?? slug;
  const bilan: string[] = [];

  const alerte = (r: any, msg: string) =>
    envoyerEmail([p.email_hote], `⚠️ Caution ${r.ref} – ${nomDe(r.logement_slug)}`,
      `<p>${r.prenom} ${r.nom} · arrivée ${r.arrivee} · ${r.telephone}</p><p>${msg}</p><p>À traiter à la main (lien de caution ou contact du voyageur).</p>`);

  // 1. Blocage la veille (ou le jour même si raté)
  const { data: aBloquer } = await sb.from("dsons_reservations").select("*")
    .in("statut", ["confirmee", "erreur_sync"]).eq("caution_statut", "a_bloquer")
    .lte("arrivee", jour(1)).gte("depart", jour(0));
  for (const r of aBloquer ?? []) {
    if (!r.stripe_payment_method_id) {
      await sb.from("dsons_reservations").update({ caution_statut: "echec", caution_erreur: "Aucune carte enregistrée" }).eq("id", r.id);
      await alerte(r, "Aucune carte enregistrée pour l'empreinte.");
      continue;
    }
    try {
      const h = await bloquerEmpreinte(r, nomDe(r.logement_slug));
      await sb.from("dsons_reservations").update({ caution_pi_id: h.id, caution_statut: "bloquee", caution_bloquee_le: new Date().toISOString(), caution_erreur: null }).eq("id", r.id);
      bilan.push(`${r.ref} bloquée`);
    } catch (e) {
      const msg = (e as Error).message;
      await sb.from("dsons_reservations").update({ caution_statut: "echec", caution_erreur: msg }).eq("id", r.id);
      await alerte(r, `L'empreinte de ${eur(r.caution_montant)} a été refusée : ${msg}`);
      bilan.push(`${r.ref} échec`);
    }
  }

  // 2. Libération 48 h après le départ / renouvellement des séjours longs
  const { data: bloquees } = await sb.from("dsons_reservations").select("*").eq("caution_statut", "bloquee");
  for (const r of bloquees ?? []) {
    try {
      const pi = await stripe(`payment_intents/${r.caution_pi_id}`, {}, "GET");
      if (pi.status === "succeeded") {
        await sb.from("dsons_reservations").update({ caution_statut: "encaissee" }).eq("id", r.id);
        continue;
      }
      if (pi.status === "canceled") {
        await sb.from("dsons_reservations").update({ caution_statut: "liberee" }).eq("id", r.id);
        continue;
      }
      const fin = jour(-2);
      const ageJours = (Date.now() - new Date(r.caution_bloquee_le).getTime()) / 86400000;
      if (r.depart <= fin) {
        await stripe(`payment_intents/${r.caution_pi_id}/cancel`);
        await sb.from("dsons_reservations").update({ caution_statut: "liberee" }).eq("id", r.id);
        bilan.push(`${r.ref} libérée`);
      } else if (ageJours >= 6) {
        // L'autorisation expirerait : on la renouvelle
        await stripe(`payment_intents/${r.caution_pi_id}/cancel`);
        const h = await bloquerEmpreinte(r, nomDe(r.logement_slug), `-renouv-${jour(0)}`);
        await sb.from("dsons_reservations").update({ caution_pi_id: h.id, caution_bloquee_le: new Date().toISOString() }).eq("id", r.id);
        bilan.push(`${r.ref} renouvelée`);
      }
    } catch (e) {
      await alerte(r, `Problème sur l'empreinte en cours : ${(e as Error).message}`);
    }
  }

  return json({ ok: true, bilan });
});
