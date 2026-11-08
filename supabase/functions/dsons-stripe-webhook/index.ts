// Webhook Stripe :
//  - paiement du séjour → réservation confirmée, créée dans SuperHote, lien de caution si arrivée < 7 jours, emails
//  - caution (enregistrement de carte) → carte gardée pour l'empreinte, bloquée la veille de l'arrivée
import { admin, iso, json, nuitsEntre } from "../_shared/commun.ts";
import { creerResaSuperHote } from "../_shared/superhote.ts";
import { bloquerEmpreinte, stripe } from "../_shared/stripe.ts";
import { envoyerEmail, b64, dateFr, eur } from "../_shared/email.ts";
import { envoyerCodeAcces, envoyerLienCaution, gabarit } from "../_shared/sejour.ts";

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

  if (evt.type === "checkout.session.completed" && session.mode === "setup") {
    return await cautionEnregistree(sb, ref, session);
  }
  if (evt.type === "checkout.session.expired" && session.mode === "setup") return json({ ok: true });
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

  // 1. Client Stripe (réutilisé pour le lien de caution)
  const maj: Record<string, unknown> = { stripe_customer_id: session.customer ?? null };

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

  // 3. Arrivée dans moins de 7 jours : lien de caution tout de suite (le code suivra l'empreinte acceptée)
  const dans7 = iso(new Date(Date.now() + 7 * 86400000));
  if (r.arrivee <= dans7) await envoyerLienCaution(sb, r, l, false, r.arrivee <= iso(new Date(Date.now() + 86400000)));

  // 4. Emails de confirmation (contrat en pièce jointe)
  const { data: pdfBlob } = await sb.storage.from(BUCKET).download(r.contrat_path);
  const pdf = pdfBlob ? [{ filename: `Contrat-${ref}.pdf`, content: b64(new Uint8Array(await pdfBlob.arrayBuffer())) }] : [];
  const nuits = nuitsEntre(r.arrivee, r.depart).length;

  await envoyerEmail([r.email], `Votre séjour à ${l.nom} est confirmé (${ref})`, `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#222;line-height:1.5">
      <h2 style="color:#1f5fd6">Merci ${r.prenom}, c'est réservé !</h2>
      <p>Nous avons bien reçu votre paiement de <b>${eur(r.montant_total)}</b>.</p>
      <p><b>${l.nom}</b> – ${l.ville}<br>
      Arrivée : ${dateFr(r.arrivee)} à partir de ${l.arrivee_heure}<br>
      Départ : ${dateFr(r.depart)} avant ${l.depart_heure}<br>
      ${nuits} nuit(s) · ${r.adultes + r.enfants} voyageur(s)</p>
      <p><b>Caution :</b> ${r.arrivee <= dans7 ? `le lien pour enregistrer votre carte (empreinte de ${eur(r.caution_montant)}, sans débit) vient de vous être envoyé dans un email séparé.` : `un lien pour enregistrer votre carte (empreinte de ${eur(r.caution_montant)}, sans débit) vous sera envoyé 7 jours avant votre arrivée.`}</p>
      <p><b>Code d'accès :</b> envoyé par email la veille de votre arrivée, <b>une fois l'empreinte de caution acceptée</b>.</p>
      ${(l.options ?? []).length ? `<p><b>Options de séjour</b> (à réserver si besoin) :</p><p>${(l.options ?? []).map((o: any) => `<a href="${o.url}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 14px;background:#1f5fd6;color:#fff;border-radius:8px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px">${o.libelle} · ${o.prix} €</a>`).join("")}</p><p style="font-size:13px;color:#666">Le départ tardif se réserve au plus tard à 9h le matin du départ.</p>` : ""}
      <p>Votre contrat de location est en pièce jointe.</p>
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
      <p>Caution ${eur(r.caution_montant)} : ${r.arrivee <= dans7 ? "lien envoyé au client" : "lien envoyé automatiquement 7 jours avant l'arrivée"}</p>
      <p>Pièces d'identité (liens valables 7 jours) : ${liens.join(" · ") || "—"}</p>
    </div>`, pdf);

  return json({ ok: true });
});

// Le client a enregistré sa carte via le lien de caution
async function cautionEnregistree(sb: any, ref: string, session: any) {
  const si = await stripe(`setup_intents/${session.setup_intent}`, {}, "GET");
  const { data: r } = await sb.from("dsons_reservations").update({
    stripe_customer_id: si.customer ?? session.customer,
    stripe_payment_method_id: si.payment_method,
    caution_statut: "carte_enregistree",
    caution_erreur: null,
  }).eq("ref", ref).in("caution_statut", ["a_bloquer", "lien_envoye", "echec"]).select("*").maybeSingle();
  if (!r) return json({ ok: true });
  const { data: l } = await sb.from("dsons_logements").select("*").eq("slug", r.logement_slug).single();
  const { data: pRows } = await sb.from("dsons_parametres").select("cle, valeur");
  const p = Object.fromEntries((pRows ?? []).map((x: any) => [x.cle, x.valeur]));

  // Arrivée aujourd'hui ou demain : empreinte bloquée tout de suite, puis code si elle est acceptée
  if (r.arrivee <= iso(new Date(Date.now() + 86400000))) {
    try {
      const h = await bloquerEmpreinte(r, l.nom, `-${session.id.slice(-8)}`);
      await sb.from("dsons_reservations").update({ caution_pi_id: h.id, caution_statut: "bloquee", caution_bloquee_le: new Date().toISOString() }).eq("id", r.id);
      r.caution_statut = "bloquee";
      if (!r.code_envoye_le) await envoyerCodeAcces(sb, r, l, p);
      return json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      await sb.from("dsons_reservations").update({ caution_statut: "echec", caution_erreur: msg }).eq("id", r.id);
      await envoyerEmail([p.email_hote], `⚠️ Caution refusée – ${ref}`, `<p>${r.prenom} ${r.nom} (${r.telephone}) : l'empreinte de ${eur(r.caution_montant)} a été refusée (${msg}). <b>Le code d'accès n'est pas envoyé.</b> Le voyageur a reçu un lien pour essayer une autre carte.</p>`);
      await envoyerLienCaution(sb, { ...r, caution_statut: "echec" }, l, true, true);
      return json({ ok: true });
    }
  }
  await envoyerEmail([r.email], `Caution enregistrée – ${l.nom}`, gabarit(`
    <p>Bonjour ${r.prenom},</p>
    <p>Merci, votre carte est bien enregistrée pour la caution de <b>${eur(r.caution_montant)}</b>. Rien n'est débité : l'empreinte est bloquée la veille de votre arrivée (${dateFr(r.arrivee)}) et libérée 48 h après votre départ.</p>
    <p>L'empreinte sera bloquée la veille de votre arrivée ; dès qu'elle est acceptée, vous recevez votre code d'accès.</p>`));
  await envoyerEmail([p.email_hote], `✅ Caution enregistrée – ${ref} – ${l.nom}`, `<p>${r.prenom} ${r.nom} · arrivée ${r.arrivee}</p>`);
  return json({ ok: true });
}
