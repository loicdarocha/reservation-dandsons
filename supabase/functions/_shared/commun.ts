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

// ---- Disponibilités complètes (SuperHote + réservations directes) ----
export async function nuitsOccupees(sb: ReturnType<typeof admin>, logement: any): Promise<Set<string>> {
  const set = await nuitsIcal(logement.ical_url);
  const limite = new Date(Date.now() - 35 * 60 * 1000).toISOString();
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
export function prixNuit(logement: any, nuit: string): number {
  const jour = parseDate(nuit).getUTCDay(); // 5 = vendredi, 6 = samedi
  const we = jour === 5 || jour === 6;
  return Number((we ? logement.prix_weekend : logement.prix_semaine) ?? logement.prix_semaine ?? 0);
}
export function devis(logement: any, arrivee: string, depart: string, adultes: number) {
  const nuits = nuitsEntre(arrivee, depart);
  const montant_nuits = nuits.reduce((t, n) => t + prixNuit(logement, n), 0);
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

export const reservable = (l: any) => !!(l.actif && l.ical_url && l.prix_semaine);
