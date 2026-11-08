// GET ?ref=…&t=… : lien de caution envoyé par email. Ouvre une page Stripe neuve (enregistrement de carte, sans débit).
import { admin } from "../_shared/commun.ts";
import { stripe } from "../_shared/stripe.ts";

const redir = (url: string) => new Response(null, { status: 303, headers: { Location: url } });

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const ref = u.searchParams.get("ref") ?? "", t = u.searchParams.get("t") ?? "";
  const sb = admin();
  const { data: pRows } = await sb.from("dsons_parametres").select("cle, valeur");
  const p = Object.fromEntries((pRows ?? []).map((x: any) => [x.cle, x.valeur]));
  const site = p.site_url ?? "https://loicdarocha.github.io/reservation-dandsons/";
  try {
    const { data: r } = await sb.from("dsons_reservations").select("*").eq("ref", ref).maybeSingle();
    if (!r || !t || r.caution_jeton !== t) return redir(`${site}?caution=invalide`);
    if (["carte_enregistree", "bloquee", "liberee", "encaissee"].includes(r.caution_statut)) return redir(`${site}?caution=deja&ref=${ref}`);
    if (r.statut === "annulee" || r.depart < new Date().toISOString().slice(0, 10)) return redir(`${site}?caution=invalide`);
    const { data: l } = await sb.from("dsons_logements").select("nom").eq("slug", r.logement_slug).single();

    let client = r.stripe_customer_id;
    if (!client) {
      const c = await stripe("customers", { email: r.email, name: `${r.prenom} ${r.nom}`, "metadata[ref]": ref });
      client = c.id;
      await sb.from("dsons_reservations").update({ stripe_customer_id: client }).eq("id", r.id);
    }
    const s = await stripe("checkout/sessions", {
      mode: "setup",
      locale: "fr",
      customer: client,
      currency: "eur",
      "payment_method_types[0]": "card",
      client_reference_id: ref,
      "metadata[ref]": ref,
      "metadata[type]": "caution",
      "setup_intent_data[metadata][ref]": ref,
      "setup_intent_data[description]": `Caution ${r.caution_montant} € – ${l?.nom ?? ""} – ${ref}`,
      "custom_text[submit][message]": `Aucun débit maintenant. Vous autorisez D and Sons à bloquer une empreinte de ${r.caution_montant} € sur cette carte la veille de votre arrivée (${r.arrivee}), libérée 48 h après votre départ, et à prélever tout ou partie de ce montant en cas de dommage, conformément au contrat ${ref}.`,
      success_url: `${site}?caution=ok&ref=${ref}`,
      cancel_url: `${site}?caution=annule&ref=${ref}`,
    });
    return redir(s.url);
  } catch (e) {
    console.error(e);
    return redir(`${site}?caution=erreur`);
  }
});
