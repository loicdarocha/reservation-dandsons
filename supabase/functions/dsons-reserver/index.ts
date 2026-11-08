// POST multipart/form-data : crée la réservation (cases cochées), stocke la CNI, génère le contrat,
// ouvre un paiement Stripe et envoie contrat + lien de paiement au client et à l'hôte
import { admin, cors, devis, json, nuitsOccupees, reservable } from "../_shared/commun.ts";
import { genererContratPdf } from "../_shared/contrat.ts";
import { stripe } from "../_shared/stripe.ts";
import { envoyerEmail, b64 as enB64, dateFr, eur } from "../_shared/email.ts";
import { gabarit } from "../_shared/sejour.ts";

const BUCKET = "dsons-documents";
const MAX = 10 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

const refAleatoire = () => "DS-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
const ext = (t: string) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" }[t] ?? "bin");

const stripeCheckout = (params: Record<string, string>) => stripe("checkout/sessions", params);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erreur: "Méthode non supportée" }, 405);
  const sb = admin();
  try {
    const f = await req.formData();
    const g = (k: string) => String(f.get(k) ?? "").trim();
    const requis = ["slug", "arrivee", "depart", "prenom", "nom", "email", "telephone"];
    const manquant = requis.filter((k) => !g(k));
    if (manquant.length) return json({ erreur: "Champs manquants : " + manquant.join(", ") }, 400);
    if (g("accepte_contrat") !== "1") return json({ erreur: "Le contrat de location doit être accepté" }, 400);
    if (g("accepte_caution") !== "1") return json({ erreur: "La caution par empreinte bancaire doit être acceptée" }, 400);
    if (!/^\S+@\S+\.\S+$/.test(g("email"))) return json({ erreur: "Email invalide" }, 400);

    const recto = f.get("cni_recto");
    const verso = f.get("cni_verso");
    if (!(recto instanceof File) || recto.size === 0) return json({ erreur: "Pièce d'identité (recto) obligatoire" }, 400);
    for (const fic of [recto, verso]) {
      if (fic instanceof File && fic.size) {
        if (fic.size > MAX) return json({ erreur: "Fichier trop lourd (10 Mo max)" }, 400);
        if (!TYPES.includes(fic.type)) return json({ erreur: "Format de fichier non accepté (JPG, PNG, PDF)" }, 400);
      }
    }

    const { data: l } = await sb.from("dsons_logements").select("*").eq("slug", g("slug")).single();
    if (!l || !reservable(l)) return json({ erreur: "Ce logement n'est pas encore réservable en ligne" }, 400);

    const adultes = Math.max(1, parseInt(g("adultes")) || 1);
    const enfants = Math.max(0, parseInt(g("enfants")) || 0);
    if (adultes + enfants > l.capacite) return json({ erreur: `Capacité maximale : ${l.capacite} personnes` }, 400);

    const d = devis(l, g("arrivee"), g("depart"), adultes);
    if (d.nuits.length < (l.nuits_min ?? 1)) return json({ erreur: `Séjour minimum : ${l.nuits_min} nuit(s)` }, 400);
    if (new Date(g("arrivee")) < new Date(new Date().toISOString().slice(0, 10))) return json({ erreur: "Date d'arrivée passée" }, 400);
    const occ = await nuitsOccupees(sb, l);
    if (d.nuits.some((n) => occ.has(n))) return json({ erreur: "Ces dates viennent d'être réservées. Choisissez d'autres dates." }, 409);

    const ref = refAleatoire();
    const dossier = `reservations/${ref}`;
    const up = async (chemin: string, corps: Blob | Uint8Array, type: string) => {
      const { error } = await sb.storage.from(BUCKET).upload(chemin, corps, { contentType: type, upsert: true });
      if (error) throw error;
      return chemin;
    };

    const cni_recto_path = await up(`${dossier}/cni-recto.${ext(recto.type)}`, recto, recto.type);
    const cni_verso_path = verso instanceof File && verso.size
      ? await up(`${dossier}/cni-verso.${ext(verso.type)}`, verso, verso.type)
      : null;

    const maintenant = new Date().toISOString();
    const acceptations = {
      contrat: { accepte: true, le: maintenant, texte: "J'ai lu et j'accepte le contrat de location saisonnière." },
      caution: { accepte: true, le: maintenant, texte: "J'accepte la caution par empreinte bancaire, lien envoyé 7 jours avant l'arrivée." },
      exactitude: { accepte: g("accepte_infos") === "1", le: maintenant, texte: "Je certifie l'exactitude des informations et de la pièce d'identité transmises." },
    };

    const resa = {
      ref,
      logement_slug: l.slug,
      arrivee: g("arrivee"),
      depart: g("depart"),
      adultes,
      enfants,
      prenom: g("prenom"),
      nom: g("nom"),
      email: g("email").toLowerCase(),
      telephone: g("telephone"),
      adresse: g("adresse") || null,
      code_postal: g("code_postal") || null,
      ville: g("ville") || null,
      pays: g("pays") || "FR",
      montant_nuits: d.montant_nuits,
      montant_menage: d.montant_menage,
      montant_taxe: d.montant_taxe,
      montant_total: d.montant_total,
      cni_recto_path,
      cni_verso_path,
      acceptations,
      contrat_signe_le: maintenant,
      signature_ip: (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
    };

    const { data: pRows } = await sb.from("dsons_parametres").select("cle, valeur");
    const params = Object.fromEntries((pRows ?? []).map((r: any) => [r.cle, r.valeur]));
    const pdf = await genererContratPdf({ params, logement: l, resa: { ...resa, caution_montant: params.caution_montant ?? 500 } });
    const contrat_path = await up(`${dossier}/contrat-${ref}.pdf`, pdf, "application/pdf");

    const caution = Number(params.caution_montant ?? 500);
    const { error: errIns } = await sb.from("dsons_reservations").insert({ ...resa, contrat_path, caution_montant: caution });
    if (errIns) throw errIns;

    const site = params.site_url ?? req.headers.get("origin") ?? "";
    const session = await stripeCheckout({
      mode: "payment",
      locale: "fr",
      customer_email: resa.email,
      customer_creation: "always",
      client_reference_id: ref,
      "metadata[ref]": ref,
      "payment_intent_data[metadata][ref]": ref,
      "payment_method_types[0]": "card",
      "payment_intent_data[description]": `${l.nom} - ${resa.arrivee} au ${resa.depart} - ${ref}`,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "eur",
      "line_items[0][price_data][unit_amount]": String(Math.round(d.montant_total * 100)),
      "line_items[0][price_data][product_data][name]": `${l.nom} - ${d.nuits.length} nuit(s)`,
      "line_items[0][price_data][product_data][description]": `Du ${resa.arrivee} au ${resa.depart} · ${adultes + enfants} voyageur(s)`,
      expires_at: String(Math.floor(Date.now() / 1000) + 23 * 3600),
      success_url: `${site}?confirmation=${ref}&logement=${l.slug}`,
      cancel_url: `${site}?logement=${l.slug}&annule=1`,
    });

    await sb.from("dsons_reservations").update({ stripe_session_id: session.id, paiement_url: session.url }).eq("ref", ref);

    // Contrat + lien de paiement : au client et à l'hôte
    const piece = [{ filename: `Contrat-${ref}.pdf`, content: enB64(pdf) }];
    const nuits = d.nuits.length;
    const recap = `<p><b>${l.nom}</b> – ${l.ville}<br>Arrivée : ${dateFr(resa.arrivee)} à partir de ${l.arrivee_heure ?? "16:00"}<br>Départ : ${dateFr(resa.depart)} avant ${l.depart_heure ?? "10:00"}<br>${nuits} nuit(s) · ${adultes + enfants} voyageur(s)<br><b>Total : ${eur(d.montant_total)}</b></p>`;
    const btnPayer = `<a href="${session.url}" style="display:inline-block;padding:13px 22px;background:#1f5fd6;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Payer mon séjour (${eur(d.montant_total)})</a>`;
    await envoyerEmail([resa.email], `Votre contrat de location et votre paiement – ${l.nom} (${ref})`, gabarit(`
      <h2 style="color:#1f5fd6">Merci ${resa.prenom} !</h2>
      <p>Vous trouverez en pièce jointe votre <b>contrat de location</b>, accepté en ligne le ${new Date(maintenant).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}. Gardez-le précieusement.</p>
      ${recap}
      <p>Votre réservation est confirmée dès le paiement :</p>
      <p style="margin:22px 0">${btnPayer}</p>
      <p style="font-size:13px;color:#666">Lien valable 23 heures. Passé ce délai, les dates sont libérées.</p>
      <p><b>Caution de ${eur(caution)} :</b> un lien pour enregistrer votre carte (empreinte, sans débit) vous sera envoyé 7 jours avant l'arrivée, ou dès le paiement si vous arrivez dans moins de 7 jours.</p>
      <p><b>Code d'accès :</b> envoyé par email la veille de votre arrivée, uniquement une fois l'empreinte de caution acceptée.</p>`), piece);
    await envoyerEmail([params.email_hote], `📝 Contrat accepté – ${ref} – ${l.nom} (paiement en attente)`, `
      <div style="font-family:Arial,sans-serif;color:#222">
      <p><b>${resa.prenom} ${resa.nom}</b> · ${resa.telephone} · ${resa.email}</p>${recap}
      <p>Contrat accepté en ligne (cases cochées) le ${new Date(maintenant).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}, IP ${resa.signature_ip ?? "-"}.</p>
      <p>Lien de paiement envoyé au client : <a href="${session.url}">${session.url}</a></p></div>`, piece);

    return json({ ref, paiement_url: session.url });
  } catch (e) {
    console.error(e);
    return json({ erreur: String((e as Error).message ?? e) }, 500);
  }
});
