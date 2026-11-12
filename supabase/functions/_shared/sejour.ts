// Étapes automatiques du séjour : lien de caution (J-7) et code d'accès Igloohome (veille de l'arrivée)
import { admin } from "./commun.ts";
import { envoyerEmail, dateFr, eur } from "./email.ts";

type SB = ReturnType<typeof admin>;
const FN = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1`;

const bouton = (url: string, texte: string) =>
  `<a href="${url}" style="display:inline-block;padding:13px 22px;background:#1f5fd6;color:#fff;border-radius:8px;text-decoration:none;font-family:Arial,sans-serif;font-weight:600">${texte}</a>`;
export const gabarit = (corps: string) =>
  `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#222;line-height:1.5">${corps}<p style="margin-top:28px">À très vite,<br>Loïc – D and Sons<br><span style="color:#666">06 15 27 25 45</span></p></div>`;

// ---------- Caution : lien permanent (il recrée une page Stripe à chaque clic) ----------
export async function envoyerLienCaution(sb: SB, r: any, l: any, relance = false, urgent = false) {
  let jeton = r.caution_jeton;
  if (!jeton) {
    jeton = crypto.randomUUID().replace(/-/g, "");
    await sb.from("dsons_reservations").update({ caution_jeton: jeton }).eq("id", r.id);
  }
  const url = `${FN()}/dsons-caution-lien?ref=${encodeURIComponent(r.ref)}&t=${jeton}`;
  const objet = urgent
    ? `Action requise : caution de ${eur(r.caution_montant)} pour recevoir votre code d'accès (${l.nom})`
    : `${relance ? "Rappel : " : ""}Caution de ${eur(r.caution_montant)} pour votre séjour à ${l.nom}`;
  await envoyerEmail([r.email], objet, gabarit(`
    ${urgent ? `<p style="background:#fff4e5;border-radius:8px;padding:12px 14px"><b>${r.caution_statut === "echec" ? "L'empreinte n'a pas été acceptée sur votre carte." : "Votre caution n'est pas encore enregistrée."}</b> Votre code d'accès vous sera envoyé dès que l'empreinte sera acceptée. ${r.caution_statut === "echec" ? "Merci d'utiliser une autre carte (carte de crédit de préférence)." : ""}</p>` : ""}
    <h2 style="color:#1f5fd6">Votre empreinte bancaire de caution</h2>
    <p>Bonjour ${r.prenom},</p>
    <p>Votre séjour à <b>${l.nom}</b> approche : arrivée le <b>${dateFr(r.arrivee)}</b>.</p>
    <p>Comme prévu au contrat, merci d'enregistrer votre carte pour la caution de <b>${eur(r.caution_montant)}</b>. <b>Aucune somme n'est débitée</b> : le montant est seulement bloqué la veille de votre arrivée, puis libéré automatiquement 48 h après votre départ.</p>
    <p style="margin:24px 0">${bouton(url, `Enregistrer ma carte pour la caution`)}</p>
    <p style="font-size:13px;color:#666">Paiement sécurisé par Stripe. Votre code d'accès vous est envoyé la veille de l'arrivée, une fois l'empreinte acceptée.</p>`));
  const maj: Record<string, unknown> = relance ? { caution_relance_le: new Date().toISOString() } : { caution_lien_envoye_le: new Date().toISOString(), caution_statut: "lien_envoye" };
  if (r.caution_statut === "echec") maj.caution_statut = "lien_envoye";
  await sb.from("dsons_reservations").update(maj).eq("id", r.id);
  return url;
}

// ---------- Igloohome ----------
let jetonIgloo: { valeur: string; expire: number } | null = null;
async function tokenIgloo() {
  if (jetonIgloo && jetonIgloo.expire > Date.now() + 60_000) return jetonIgloo.valeur;
  const id = Deno.env.get("IGLOO_CLIENT_ID"), secret = Deno.env.get("IGLOO_CLIENT_SECRET");
  if (!id || !secret) throw new Error("Igloohome non configuré (IGLOO_CLIENT_ID / IGLOO_CLIENT_SECRET)");
  const res = await fetch("https://auth.igloohome.co/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${id}:${secret}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await res.json();
  if (!res.ok) throw new Error("Igloohome (jeton) : " + (j.error_description ?? j.error ?? res.status));
  jetonIgloo = { valeur: j.access_token, expire: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return jetonIgloo.valeur;
}

// Décalage horaire de Paris à une date donnée, ex. "+01:00" ou "+02:00"
function decalageParis(jour: string, heure: number) {
  const ref = new Date(`${jour}T${String(heure).padStart(2, "0")}:00:00Z`);
  const parties = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).formatToParts(ref);
  const hParis = Number(parties.find((p) => p.type === "hour")?.value ?? heure);
  const ecart = ((hParis - ref.getUTCHours()) + 24) % 24;
  return `+${String(ecart).padStart(2, "0")}:00`;
}
const dateIgloo = (jour: string, heure: number) => `${jour}T${String(heure).padStart(2, "0")}:00:00${decalageParis(jour, heure)}`;

export async function genererCodeIgloo(l: any, r: any) {
  if (!l.igloo_device_id) throw new Error(`Aucune serrure Igloohome reliée à ${l.nom} (igloo_device_id vide)`);
  const hArrivee = parseInt(String(l.arrivee_heure ?? "16").slice(0, 2), 10);
  // Le code reste valable jusqu'à 13h le jour du départ, pour couvrir le départ tardif
  const hFin = Math.max(13, parseInt(String(l.depart_heure ?? "10").slice(0, 2), 10));
  // Igloohome refuse un début dans le passé : arrivée le jour même après l'heure d'arrivée → heure pleine suivante
  let hDebut = hArrivee;
  const maintenantParis = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const pp = Object.fromEntries(maintenantParis.map((x) => [x.type, x.value]));
  if (`${pp.year}-${pp.month}-${pp.day}` === r.arrivee) hDebut = Math.min(23, Math.max(hArrivee, Number(pp.hour) + 1));
  const debut = dateIgloo(r.arrivee, hDebut);
  let fin = dateIgloo(r.depart, hFin);
  const heures = (new Date(fin).getTime() - new Date(debut).getTime()) / 3600000;
  // Codes « daily » : 29 jours minimum chez Igloohome (cas rare d'un séjour de 28 à 29 jours)
  if (heures > 672 && heures < 29 * 24) {
    const j = new Date(r.arrivee + "T00:00:00Z"); j.setUTCDate(j.getUTCDate() + 29);
    const jj = j.toISOString().slice(0, 10);
    fin = dateIgloo(jj, hArrivee);
  }
  const type = heures <= 672 ? "hourly" : "daily";
  const res = await fetch(`https://api.igloodeveloper.co/igloohome/devices/${encodeURIComponent(l.igloo_device_id)}/algopin/${type}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenIgloo()}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ variance: 1, startDate: debut, endDate: fin, accessName: `${r.prenom} ${r.nom} ${r.ref}`.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 _=+,.@-]/g, "").slice(0, 60) }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Igloohome ${res.status} : ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt);
  if (!j.pin) throw new Error("Igloohome : réponse sans code");
  return { pin: String(j.pin), pinId: j.pinId ?? null, debut, fin };
}

export async function envoyerCodeAcces(sb: SB, r: any, l: any, p: Record<string, string>) {
  try {
    const { pin, pinId } = await genererCodeIgloo(l, r);
    await sb.from("dsons_reservations").update({ code_acces: pin, code_pin_id: pinId, code_envoye_le: new Date().toISOString(), code_erreur: null }).eq("id", r.id);
    await envoyerEmail([r.email], `Votre code d'accès pour ${l.nom}`, gabarit(`
      <h2 style="color:#1f5fd6">Votre code d'accès</h2>
      <p>Bonjour ${r.prenom},</p>
      <p>Voici votre code d'accès personnel pour <b>${l.nom}</b> :</p>
      <p style="font-size:34px;font-weight:700;letter-spacing:6px;margin:18px 0;color:#1f5fd6">${pin}</p>
      <p>Il fonctionne du <b>${dateFr(r.arrivee)} à ${l.arrivee_heure ?? "16:00"}</b> jusqu'au <b>${dateFr(r.depart)}</b> à 13h.</p>
      <p><b>Comment l'utiliser :</b> réveillez le clavier en le touchant, tapez le code puis le bouton de validation (🔓). <b>Utilisez-le pour la première fois le jour de votre arrivée</b> : il doit être activé dans les 24 h qui suivent l'heure d'arrivée.</p>
      <p>Arrivée à partir de ${l.arrivee_heure ?? "16:00"}, départ avant ${l.depart_heure ?? "10:00"}.</p>
      ${(l.options ?? []).length ? `<p>Envie d'arriver plus tôt ou de partir plus tard ?<br>${(l.options ?? []).map((o: any) => `<a href="${o.url}">${o.libelle} (${o.prix} €)</a>`).join(" · ")}</p>` : ""}`));
    await envoyerEmail([p.email_hote], `🔑 Code envoyé – ${r.ref} – ${l.nom}`, `<p>${r.prenom} ${r.nom} · arrivée ${r.arrivee} · code ${pin}</p><p>Caution : ${r.caution_statut}</p>`);
    return pin;
  } catch (e) {
    const msg = (e as Error).message;
    await sb.from("dsons_reservations").update({ code_erreur: msg }).eq("id", r.id);
    await envoyerEmail([p.email_hote], `⚠️ Code d'accès NON envoyé – ${r.ref} – ${l.nom}`,
      `<p>${r.prenom} ${r.nom} arrive le ${r.arrivee} (${r.telephone}, ${r.email}).</p><p>Le code Igloohome n'a pas pu être généré : ${msg}</p><p><b>Envoie-lui un code à la main.</b></p>`);
    return null;
  }
}
