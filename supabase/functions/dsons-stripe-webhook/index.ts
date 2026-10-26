// Webhook Stripe : paiement confirmé → réservation payée, créée dans SuperHote, carte enregistrée pour la caution, emails envoyés
import { admin, iso, json, nuitsEntre } from "../_shared/commun.ts";
import { creerResaSuperHote } from "../_shared/superhote.ts";
import { bloquerEmpreinte, stripe } from "../_shared/stripe.ts";
import { envoyerEmail, b64, dateFr, eur } from "../_shared/email.ts";

const BUCKET = "dsons-documents";
const enc = new TextEncoder();

async function verifierSignature(corps: string, entete: string | null, secret: string) {
  if (!entete || !secret) return false;
  const t = entete.split(",").find((p) => p.startsWith("t="))?.slice(2);
  const sigs = entete.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const cle = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cle, enc.encode(`${t}.${corps}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.includes(hex);
}

Deno.serve(async (req) => {
  const corps = await req.text();
  if (!(await verifierSignature(corps, req.headers.get("stripe-signature"), Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? ""))) {
    return json({ erreur: "Signature invalide" }, 400);
  }
  const evt = JSON.parse(corps);
  const session = evt.data?.object ?? {};
  const ref = session.metadata?.ref ?? session.client_reference_id;
  if (!ref) return json({ ok: true });
  const sb = admin();

  if (evt.type === "checkout.session.expired") {
    await sb.from("dsons_reservations").update({ statut: "annulee" }).eq("ref", ref).eq("statut", "en_attente_paiement");
    return json({ ok: true });
  }
  if (evt.type !== "checkout.session.completed" || session.payment_status !== "paid") return json({ ok: true });

  // Verrou d'idempotence : seule la première livraison passe
  const { data: r } = await sb.from("dsons_reservations").update({ statut: "payee" })
    .eq("ref", ref).eq("statut", "en_attente_paiement").select("*").maybeSingle();
  if (!r) return json({ ok: true });

  const { data: l } = await sb.from("dsons_logements").select("*").eq("slug", r.logement_slug).single();
  const { data: pRows } = await sb.from("dsons_parametres").select("cle, valeur");
  const p = Object.fromEntries((pRows ?? []).map((x: any) => [x.cle, x.valeur]));

  // 1. Carte enregistrée pour la caution
  const maj: Record<string, unknown> = {};
  try {
    const pi = await stripe(`payment_intents/${session.payment_intent}`, {}, "GET");
    maj.stripe_customer_id = pi.customer ?? session.customer;
    maj.stripe_payment_method_id = pi.payment_method;
  } catch (e) {
    maj.caution_statut = "echec";
    maj.caution_erreur = "Carte non récupérée : " + (e as Error).message;
  }

  // 2. Synchro SuperHote (bloque les nuits partout + fiche voyageur dans l'appli)
  maj.statut = "confirmee";
  try {
    maj.superhote_reservation_id = await creerResaSuperHote(l, r);
    maj.erreur = null;
  } catch (e) {
    maj.statut = "erreur_sync";
    maj.erreur = String((e as Error).message);
  }
  await sb.from("dsons_reservations").update(maj).eq("ref", ref);
  Object.assign(r, maj);

  // 3. Arrivée demain ou aujourd'hui : empreinte tout de suite
  const demain = iso(new Date(Date.now() + 86400000));
  if (r.arrivee <= demain && r.stripe_payment_method_id && r.caution_statut === "a_bloquer") {
    try {
      const h = await bloquerEmpreinte(r, l.nom);
      await sb.from("dsons_reservations").update({ caution_pi_id: h.id, caution_statut: "bloquee", caution_bloquee_le: new Date().toISOString() }).eq("ref", ref);
    } catch (e) {
      await sb.from("dsons_reservations").update({ caution_statut: "echec", caution_erreur: (e as Error).message }).eq("ref", ref);
    }
  }

  // 4. Emails avec le contrat signé
  const { data: pdfBlob } = await sb.storage.from(BUCKET).download(r.contrat_path);
  const pdf = pdfBlob ? [{ filename: `Contrat-${ref}.pdf`, content: b64(new Uint8Array(await pdfBlob.arrayBuffer())) }] : [];
  const nuits = nuitsEntre(r.arrivee, r.depart).length;

  await envoyerEmail([r.email], `Votre séjour à ${l.nom} est confirmé (${ref})`, `
    <div style="font-family:Georgia,serif;max-width:560px;margin:auto;color:#2b2420">
      <h2 style="color:#9e4d30">Merci ${r.prenom}, c'est réservé !</h2>
      <p>Nous avons bien reçu votre paiement de <b>${eur(r.montant_total)}</b>.</p>
      <p><b>${l.nom}</b> – ${l.ville}<br>
      Arrivée : ${dateFr(r.arrivee)} à partir de ${l.arrivee_heure}<br>
      Départ : ${dateFr(r.depart)} avant ${l.depart_heure}<br>
      ${nuits} nuit(s) · ${r.adultes + r.enfants} voyageur(s)</p>
      <p><b>Caution :</b> une empreinte bancaire de ${eur(r.caution_montant)} sera réalisée sur votre carte la veille de votre arrivée. Rien n'est débité ; elle est libérée automatiquement 48 h après votre départ.</p>
      <p>Votre contrat de location signé est en pièce jointe. Les codes d'accès et le livret d'accueil vous seront envoyés avant votre arrivée.</p>
      <p>Une question ? ${p.telephone_hote} · ${p.email_hote}</p>
      <p>À très vite,<br>Loïc – D and Sons</p>
    </div>`, pdf);

  const liens: string[] = [];
  for (const [nom, chemin] of [["CNI recto", r.cni_recto_path], ["CNI verso", r.cni_verso_path]] as const) {
    if (!chemin) continue;
    const { data } = await sb.storage.from(BUCKET).createSignedUrl(chemin, 60 * 60 * 24 * 7);
    if (data?.signedUrl) liens.push(`<a href="${data.signedUrl}">${nom}</a>`);
  }
  const ok = r.statut === "confirmee";
  await envoyerEmail([p.email_hote], `${ok ? "✅" : "⚠️"} Réservation directe ${ref} – ${l.nom}`, `
    <div style="font-family:Arial,sans-serif;color:#222">
      <h3>Nouvelle réservation directe ${ref}</h3>
      <p><b>${l.nom}</b> · ${r.arrivee} → ${r.depart} (${nuits} nuit(s))<br>
      ${r.prenom} ${r.nom} · ${r.telephone} · ${r.email}<br>
      ${r.adultes} adulte(s), ${r.enfants} enfant(s)<br>
      Payé : ${eur(r.montant_total)}</p>
      <p>SuperHote : ${ok ? "réservation créée ✅ (visible dans l'appli, messagerie disponible)" : `<b style="color:#b00">ÉCHEC – à saisir manuellement pour bloquer Airbnb/Booking</b><br><small>${r.erreur}</small>`}</p>
      <p>Caution ${eur(r.caution_montant)} : ${r.caution_statut === "echec" ? `<b style="color:#b00">problème – ${r.caution_erreur}</b>` : "empreinte programmée la veille de l'arrivée"}</p>
      <p>Pièces d'identité (liens valables 7 jours) : ${liens.join(" · ") || "—"}</p>
    </div>`, pdf);

  return json({ ok: true });
});
