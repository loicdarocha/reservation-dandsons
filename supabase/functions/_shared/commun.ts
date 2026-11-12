import { createClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

export const admin = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

// ---- Dates ----
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const parseDate = (s: string) => new Date(s + "T00:00:00Z");
export function nuitsEntre(arrivee: string, depart: string): string[] {
  const out: string[] = [];
  for (let d = parseDate(arrivee); d < parseDate(depart); d.setUTCDate(d.getUTCDate() + 1)) out.push(iso(d));
  return out;
}

// ---- iCal SuperHote ----
function icalDate(v: string): string | null {
  const m = v.match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
export async function nuitsIcal(url: string | null): Promise<Set<string>> {
  const set = new Set<string>();
  if (!url) return set;
  const res = await fetch(url, { headers: { "User-Agent": "DandSons-Reservation" } });
  if (!res.ok) throw new Error(`iCal indisponible (${res.status})`);
  const txt = (await res.text()).replace(/\r?\n[ \t]/g, "");
  for (const bloc of txt.split("BEGIN:VEVENT").slice(1)) {
    const s = bloc.match(/^DTSTART[^:]*:(.+)$/m)?.[1];
    const e = bloc.match(/^DTEND[^:]*:(.+)$/m)?.[1];
    const ds = s && icalDate(s);
    const de = e && icalDate(e);
    if (ds && de) nuitsEntre(ds, de).forEach((n) => set.add(n));
    else if (ds) set.add(ds);
  }
  return set;
}

// ---- Calendrier SuperHote (dispo, prix PriceLabs, minimum de nuits) ----
export type Nuit = { dispo: boolean; prix: number | null; min: number; sansArrivee: boolean; sansDepart: boolean };
const cacheCal = new Map<string, { t: number; jours: Map<string, Nuit> }>();
export async function calendrierSuperHote(logement: any, de: string, a: string, sansCache = false): Promise<Map<string, Nuit>> {
  const cle = `${logement.superhote_id}|${de}|${a}`;
  const c = cacheCal.get(cle);
  if (!sansCache && c && Date.now() - c.t < 60_000) return c.jours; // 1 min de cache : reste frais sans saturer SuperHote
  const base = (Deno.env.get("SUPERHOTE_API_URL") ?? "https://connect.superhote.com/api/v2/public").replace(/\/$/, "");
  // SuperHote limite la plage par appel : tranches de 90 jours, en parallèle
  const tranches: [string, string][] = [];
  for (let d = parseDate(de); iso(d) <= a; d.setUTCDate(d.getUTCDate() + 90)) {
    const f = new Date(d); f.setUTCDate(f.getUTCDate() + 89);
    tranches.push([iso(d), iso(f) < a ? iso(f) : a]);
  }
  const jours = new Map<string, Nuit>();
  await Promise.all(tranches.map(async ([x, y]) => {
    const res = await fetch(`${base}/rentals/${logement.superhote_id}/calendar?from=${x}&to=${y}`, {
      headers: { Authorization: `Bearer ${Deno.env.get("SUPERHOTE_API_KEY")}`, Accept: "application/json" },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(`Calendrier SuperHote indisponible (${res.status} ${j.message ?? ""})`);
    for (const d of j.result?.days ?? []) {
      jours.set(d.date, { dispo: !!d.available, prix: d.price == null ? null : Number(d.price), min: Number(d.min_nights ?? 1), sansArrivee: !!d.no_checkin, sansDepart: !!d.no_checkout });
    }
  }));
  cacheCal.set(cle, { t: Date.now(), jours });
  return jours;
}

// ---- Disponibilités complètes (SuperHote + réservations directes en cours) ----
export async function nuitsOccupees(sb: ReturnType<typeof admin>, logement: any, cal?: Map<string, Nuit>): Promise<Set<string>> {
  const set = new Set<string>();
  if (logement.superhote_id) {
    const jours = cal ?? await calendrierSuperHote(logement, iso(new Date()), iso(new Date(Date.now() + 366 * 86400000)));
    for (const [d, n] of jours) if (!n.dispo) set.add(d);
  } else {
    (await nuitsIcal(logement.ical_url)).forEach((n) => set.add(n));
  }
  const limite = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await sb
    .from("dsons_reservations")
    .select("arrivee, depart")
    .eq("logement_slug", logement.slug)
    .gte("depart", iso(new Date()))
    .or(`statut.in.(payee,confirmee,erreur_sync),and(statut.eq.en_attente_paiement,created_at.gt.${limite})`);
  for (const r of data ?? []) nuitsEntre(r.arrivee, r.depart).forEach((n) => set.add(n));
  return set;
}

// ---- Tarification ----
// Prix de la nuit : celui de SuperHote (alimenté par PriceLabs), sinon la grille de secours semaine / week-end.
// remise = % de réduction accordé sur le site par rapport à SuperHote (paramètre remise_site_pct, 0 par défaut).
export function prixNuit(logement: any, nuit: string, cal?: Map<string, Nuit>, remise = 0): number {
  const sh = cal?.get(nuit)?.prix;
  let p: number;
  if (sh != null && sh > 0) p = sh;
  else {
    const jour = parseDate(nuit).getUTCDay(); // 5 = vendredi, 6 = samedi
    const we = jour === 5 || jour === 6;
    p = Number((we ? logement.prix_weekend : logement.prix_semaine) ?? logement.prix_semaine ?? 0);
  }
  return Math.round(p * (1 - remise / 100) * 100) / 100;
}
export function devis(logement: any, arrivee: string, depart: string, adultes: number, cal?: Map<string, Nuit>, remise = 0) {
  const nuits = nuitsEntre(arrivee, depart);
  const montant_nuits = Math.round(nuits.reduce((t, n) => t + prixNuit(logement, n, cal, remise), 0) * 100) / 100;
  const montant_menage = Number(logement.menage ?? 0);
  const montant_taxe = Math.round(Number(logement.taxe_sejour_pp ?? 0) * adultes * nuits.length * 100) / 100;
  return {
    nuits,
    montant_nuits,
    montant_menage,
    montant_taxe,
    montant_total: Math.round((montant_nuits + montant_menage + montant_taxe) * 100) / 100,
  };
}

export const reservable = (l: any) => !!(l.actif && (l.superhote_id || l.ical_url) && l.prix_semaine);

// Règles SuperHote d'un séjour : minimum de nuits (celui de la nuit d'arrivée), jours sans arrivée / sans départ
export function regleSejour(cal: Map<string, Nuit> | undefined, arrivee: string, depart: string, minDefaut = 1): string | null {
  const n = nuitsEntre(arrivee, depart).length;
  const min = Math.max(minDefaut, cal?.get(arrivee)?.min ?? 1);
  if (n < min) return `Minimum ${min} nuits pour une arrivée à cette date.`;
  if (cal?.get(arrivee)?.sansArrivee) return "Pas d'arrivée possible ce jour-là.";
  if (cal?.get(depart)?.sansDepart) return "Pas de départ possible ce jour-là.";
  return null;
}

export async function remiseSite(sb: ReturnType<typeof admin>) {
  const { data } = await sb.from("dsons_parametres").select("valeur").eq("cle", "remise_site_pct").maybeSingle();
  return Math.min(50, Math.max(0, Number(data?.valeur ?? 0) || 0));
}
