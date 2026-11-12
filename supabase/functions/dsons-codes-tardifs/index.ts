// Rattrapage des codes d'accès pour les réservations tardives (Airbnb), toutes les 5 minutes via pg_cron.
// Igloohome envoie le code à heure fixe le jour de l'arrivée (7h / 8h) : une réservation faite après ne le reçoit pas.
// Ici : réservation du jour, faite après l'heure d'envoi Igloohome, sans code déjà envoyé
//   → code Igloohome généré pour le séjour → message habituel envoyé dans la conversation Airbnb via SuperHote.
// Tant qu'un logement a actif = false, rien n'est envoyé : la fonction enregistre seulement ce qu'elle aurait fait.
import { createClient } from "npm:@supabase/supabase-js@2";

const SH = "https://connect.superhote.com/api/v2/public";
const IGLOO = "https://api.igloodeveloper.co/igloohome";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// ---------- Heure de Paris ----------
function partiesParis(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { jour: `${p.year}-${p.month}-${p.day}`, heure: Number(p.hour) };
}
function decalage(jour: string, heure: number) {
  const ref = new Date(`${jour}T${String(heure).padStart(2, "0")}:00:00Z`);
  const h = partiesParis(ref).heure;
  return `+${String(((h - ref.getUTCHours()) + 24) % 24).padStart(2, "0")}:00`;
}
const dateIgloo = (jour: string, heure: number) => `${jour}T${String(heure).padStart(2, "0")}:00:00${decalage(jour, heure)}`;
const instantParis = (jour: string, heure: number) => new Date(dateIgloo(jour, heure));

// ---------- SuperHote ----------
async function sh(chemin: string, init: RequestInit = {}) {
  const res = await fetch(`${SH}${chemin}`, { ...init, headers: { Authorization: `Bearer ${Deno.env.get("SUPERHOTE_API_KEY")}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(`SuperHote ${res.status} : ${j.message ?? JSON.stringify(j).slice(0, 200)}`);
  return j.result;
}

// ---------- Igloohome ----------
async function jetonIgloo() {
  const id = (Deno.env.get("IGLOO_CLIENT_ID") ?? "").trim(), secret = (Deno.env.get("IGLOO_CLIENT_SECRET") ?? "").trim();
  const r = await fetch("https://auth.igloohome.co/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${id}:${secret}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Igloohome (jeton) : " + (j.error ?? r.status));
  return j.access_token as string;
}
async function creerPin(deviceId: string, debut: string, fin: string, nom: string) {
  const heures = (new Date(fin).getTime() - new Date(debut).getTime()) / 3600000;
  const type = heures <= 672 ? "hourly" : "daily";
  const r = await fetch(`${IGLOO}/devices/${encodeURIComponent(deviceId)}/algopin/${type}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await jetonIgloo()}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ variance: 1, startDate: debut, endDate: fin, accessName: nom.replace(/[^A-Za-z0-9 _=+,.@-]/g, "").slice(0, 60) || "Voyageur" }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Igloohome ${r.status} : ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt);
  if (!j.pin) throw new Error("Igloohome : réponse sans code");
  return { pin: String(j.pin), pinId: j.pinId ?? null };
}

const nettoyer = (s: unknown) => String(s ?? "").replace(/<\/?untrusted_content[^>]*>/g, "").trim();

Deno.serve(async (req) => {
  const u = new URL(req.url);

  const { data: config } = await sb.from("dsons_codes_auto").select("*");
  const parLogement = new Map((config ?? []).map((c: any) => [Number(c.superhote_rental_id), c]));
  const maintenant = partiesParis(new Date());
  const jour = u.searchParams.get("jour") ?? maintenant.jour; // ?jour=AAAA-MM-JJ pour rejouer un jour passé en simulation
  const bilan: any[] = [];

  const { reservations } = await sh(`/reservations?status=CONFIRMED&checkin_from=${jour}&checkin_to=${jour}&per_page=100`);
  for (const r of reservations ?? []) {
    const c = parLogement.get(Number(r.rental_id));
    if (!c) continue;                                   // logement non configuré
    if (Number(r.platform) !== 1) continue;            // Airbnb uniquement (l'envoi Igloohome actuel est celui d'Airbnb)
    const reserveLe = new Date(r.booked_at ?? r.created_at);
    if (reserveLe < instantParis(jour, c.heure_envoi_igloo)) continue; // réservée avant l'envoi Igloohome : déjà couverte

    const { data: deja } = await sb.from("dsons_codes_envoyes").select("statut").eq("superhote_reservation_id", r.id).maybeSingle();
    if (deja && deja.statut !== "erreur" && !(deja.statut === "simule" && c.actif)) continue;

    const prenom = nettoyer(r.guest_first_name) || "et bienvenue";
    const nom = `${prenom} ${nettoyer(r.guest_last_name)}`.trim();
    const ligne: any = { superhote_reservation_id: r.id, superhote_rental_id: r.rental_id, arrivee: r.checkin, reserve_le: reserveLe.toISOString() };
    try {
      // Un code est-il déjà parti (envoi manuel ou Igloohome) ?
      const { messages } = await sh(`/reservations/${r.id}/messages?direction=outbound&per_page=50`);
      if ((messages ?? []).some((m: any) => /code d.acc[eè]s actif/i.test(nettoyer(m.content)))) {
        Object.assign(ligne, { statut: "ignore", detail: "Un message avec le code d'accès a déjà été envoyé" });
      } else if (!c.actif) {
        Object.assign(ligne, { statut: "simule", detail: c.modele.replace("{prenom}", prenom).replace("{code}", "•••••••••") });
      } else {
        const hDebut = jour === maintenant.jour ? Math.max(c.heure_debut, maintenant.heure) : c.heure_debut;
        const fin = dateIgloo(r.checkout, c.heure_fin);
        let code;
        try { code = await creerPin(c.igloo_device_id, dateIgloo(r.checkin, hDebut), fin, nom); }
        catch (e) {
          // Igloohome refuse un début dans le passé : on démarre à l'heure pleine suivante
          if (!/now or after/i.test((e as Error).message) || hDebut >= 23) throw e;
          code = await creerPin(c.igloo_device_id, dateIgloo(r.checkin, hDebut + 1), fin, nom);
        }
        const { pin, pinId } = code;
        await sh(`/reservations/${r.id}/messages`, { method: "POST", body: JSON.stringify({ channel: "platform", content: c.modele.replace("{prenom}", prenom).replace("{code}", pin) }) });
        Object.assign(ligne, { statut: "envoye", code: pin, pin_id: pinId, detail: `Envoyé à ${new Date().toISOString()}` });
      }
    } catch (e) {
      Object.assign(ligne, { statut: "erreur", detail: (e as Error).message });
    }
    await sb.from("dsons_codes_envoyes").upsert(ligne);
    bilan.push({ reservation: r.id, logement: c.nom, statut: ligne.statut, detail: ligne.statut === "simule" ? "message prêt" : ligne.detail });
  }
  return Response.json({ ok: true, jour, traitees: bilan });
});
