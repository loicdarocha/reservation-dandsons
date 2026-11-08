// Tâche quotidienne (pg_cron, 9h Paris) — le déroulé automatique de chaque séjour réservé en direct :
//  1. J-7     : lien de caution envoyé au client (enregistrement de carte, sans débit) ; rappel à J-2
//  2. J-1     : empreinte de 500 € bloquée sur la carte enregistrée (alerte à l'hôte si pas de carte)
//  3. J-1     : code d'accès Igloohome généré et envoyé UNIQUEMENT si l'empreinte est acceptée
//  4. séjours longs : empreinte renouvelée avant ses 7 jours de validité Stripe
//  5. départ + 48 h : empreinte libérée si l'hôte ne l'a pas encaissée dans Stripe
import { admin, iso, json } from "../_shared/commun.ts";
import { bloquerEmpreinte, stripe } from "../_shared/stripe.ts";
import { envoyerEmail, eur } from "../_shared/email.ts";
import { envoyerCodeAcces, envoyerLienCaution } from "../_shared/sejour.ts";

const jour = (decalage: number) => iso(new Date(Date.now() + decalage * 86400000));
const CONFIRMEES = ["confirmee", "erreur_sync"];

Deno.serve(async () => {
  const sb = admin();
  const { data: pRows } = await sb.from("dsons_parametres").select("cle, valeur");
  const p = Object.fromEntries((pRows ?? []).map((x: any) => [x.cle, x.valeur]));
  const { data: logements } = await sb.from("dsons_logements").select("*");
  const logementDe = (slug: string) => logements?.find((l: any) => l.slug === slug) ?? { nom: slug };
  const bilan: string[] = [];
  const alerte = (r: any, msg: string) =>
    envoyerEmail([p.email_hote], `⚠️ Caution ${r.ref} – ${logementDe(r.logement_slug).nom}`,
      `<p>${r.prenom} ${r.nom} · arrivée ${r.arrivee} · ${r.telephone} · ${r.email}</p><p>${msg}</p>`);

  // 1. Lien de caution à J-7 (et rattrapage si la réservation est plus proche)
  const { data: aEnvoyer } = await sb.from("dsons_reservations").select("*")
    .in("statut", CONFIRMEES).eq("caution_statut", "a_bloquer").is("caution_lien_envoye_le", null)
    .lte("arrivee", jour(7)).gte("arrivee", jour(0));
  for (const r of aEnvoyer ?? []) {
    try { await envoyerLienCaution(sb, r, logementDe(r.logement_slug)); bilan.push(`${r.ref} lien caution`); }
    catch (e) { await alerte(r, `Le lien de caution n'a pas pu être envoyé : ${(e as Error).message}`); }
  }
  //    Rappel à J-2 si la carte n'est toujours pas enregistrée
  const { data: aRelancer } = await sb.from("dsons_reservations").select("*")
    .in("statut", CONFIRMEES).eq("caution_statut", "lien_envoye").is("caution_relance_le", null)
    .lte("arrivee", jour(2)).gt("arrivee", jour(1));
  for (const r of aRelancer ?? []) {
    try { await envoyerLienCaution(sb, r, logementDe(r.logement_slug), true); bilan.push(`${r.ref} rappel caution`); } catch { /* sans gravité */ }
  }

  // 2. Empreinte la veille de l'arrivée
  const { data: aBloquer } = await sb.from("dsons_reservations").select("*")
    .in("statut", CONFIRMEES).eq("caution_statut", "carte_enregistree")
    .lte("arrivee", jour(1)).gte("depart", jour(0));
  for (const r of aBloquer ?? []) {
    try {
      const h = await bloquerEmpreinte(r, logementDe(r.logement_slug).nom, `-${String(r.stripe_payment_method_id).slice(-8)}`);
      await sb.from("dsons_reservations").update({ caution_pi_id: h.id, caution_statut: "bloquee", caution_bloquee_le: new Date().toISOString(), caution_erreur: null }).eq("id", r.id);
      bilan.push(`${r.ref} empreinte bloquée`);
    } catch (e) {
      const msg = (e as Error).message;
      await sb.from("dsons_reservations").update({ caution_statut: "echec", caution_erreur: msg }).eq("id", r.id);
      await alerte(r, `L'empreinte de ${eur(r.caution_montant)} a été refusée : ${msg}. <b>Le code d'accès n'est pas envoyé.</b> Le voyageur a reçu un lien pour essayer une autre carte.`);
      try { await envoyerLienCaution(sb, { ...r, caution_statut: "echec" }, logementDe(r.logement_slug), true, true); } catch { /* alerte déjà envoyée */ }
    }
  }
  const { data: sansCarte } = await sb.from("dsons_reservations").select("*")
    .in("statut", CONFIRMEES).in("caution_statut", ["a_bloquer", "lien_envoye"]).eq("arrivee", jour(1));
  for (const r of sansCarte ?? []) {
    await alerte(r, `Le voyageur arrive demain et n'a <b>pas encore enregistré sa carte</b> pour la caution de ${eur(r.caution_montant)}. <b>Son code d'accès ne partira qu'une fois l'empreinte acceptée.</b>`);
    try { await envoyerLienCaution(sb, r, logementDe(r.logement_slug), true, true); } catch { /* sans gravité */ }
  }

  // 3. Code d'accès Igloohome la veille de l'arrivée — uniquement si l'empreinte est acceptée
  const { data: aCoder } = await sb.from("dsons_reservations").select("*")
    .in("statut", CONFIRMEES).eq("caution_statut", "bloquee").is("code_envoye_le", null)
    .lte("arrivee", jour(1)).gte("depart", jour(0));
  for (const r of aCoder ?? []) {
    if (r.code_erreur && r.arrivee > jour(0)) continue; // déjà signalé à l'hôte hier, on ne spamme pas
    const pin = await envoyerCodeAcces(sb, r, logementDe(r.logement_slug), p);
    bilan.push(`${r.ref} code ${pin ? "envoyé" : "ÉCHEC"}`);
  }

  // 4–5. Libération 48 h après le départ / renouvellement des séjours longs
  const { data: bloquees } = await sb.from("dsons_reservations").select("*").eq("caution_statut", "bloquee");
  for (const r of bloquees ?? []) {
    try {
      const pi = await stripe(`payment_intents/${r.caution_pi_id}`, {}, "GET");
      if (pi.status === "succeeded") { await sb.from("dsons_reservations").update({ caution_statut: "encaissee" }).eq("id", r.id); continue; }
      if (pi.status === "canceled") { await sb.from("dsons_reservations").update({ caution_statut: "liberee" }).eq("id", r.id); continue; }
      const ageJours = (Date.now() - new Date(r.caution_bloquee_le).getTime()) / 86400000;
      if (r.depart <= jour(-2)) {
        await stripe(`payment_intents/${r.caution_pi_id}/cancel`);
        await sb.from("dsons_reservations").update({ caution_statut: "liberee" }).eq("id", r.id);
        bilan.push(`${r.ref} libérée`);
      } else if (ageJours >= 6) {
        await stripe(`payment_intents/${r.caution_pi_id}/cancel`);
        const h = await bloquerEmpreinte(r, logementDe(r.logement_slug).nom, `-renouv-${jour(0)}`);
        await sb.from("dsons_reservations").update({ caution_pi_id: h.id, caution_bloquee_le: new Date().toISOString() }).eq("id", r.id);
        bilan.push(`${r.ref} renouvelée`);
      }
    } catch (e) {
      await alerte(r, `Problème sur l'empreinte en cours : ${(e as Error).message}`);
    }
  }

  return json({ ok: true, bilan });
});
