// GET  ?            → liste des logements (vitrine)
// GET  ?slug=xxx    → logement + nuits occupées (12 mois) + grille de prix
// POST {slug, arrivee, depart, adultes} → devis + disponibilité
import { admin, cors, devis, json, nuitsEntre, nuitsOccupees, prixNuit, reservable, iso } from "../_shared/commun.ts";

const CHAMPS =
  "slug,nom,ville,capacite,menage,taxe_sejour_pp,prix_semaine,prix_weekend,nuits_min,description,equipements,photos,arrivee_heure,depart_heure,ordre,ical_url,actif,titre,description_longue,chambres,lits,salles_de_bain,note,nb_avis,latitude,longitude,options";

const publicLogement = (l: any) => {
  const { ical_url, ...reste } = l;
  return { ...reste, reservable: reservable(l) };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = admin();
  try {
    if (req.method === "GET") {
      const slug = new URL(req.url).searchParams.get("slug");
      if (!slug) {
        const { data, error } = await sb.from("dsons_logements").select(CHAMPS).eq("actif", true).order("ordre");
        if (error) throw error;
        return json({ logements: data.map(publicLogement) });
      }
      const { data: l } = await sb.from("dsons_logements").select(CHAMPS).eq("slug", slug).single();
      if (!l) return json({ erreur: "Logement introuvable" }, 404);
      let occupees: string[] = [];
      const prix: Record<string, number> = {};
      if (reservable(l)) {
        occupees = [...(await nuitsOccupees(sb, l))];
        const debut = iso(new Date());
        const fin = new Date();
        fin.setUTCFullYear(fin.getUTCFullYear() + 1);
        for (const n of nuitsEntre(debut, iso(fin))) prix[n] = prixNuit(l, n);
      }
      return json({ logement: publicLogement(l), occupees, prix });
    }

    if (req.method === "POST") {
      const { slug, arrivee, depart, adultes = 1 } = await req.json();
      const { data: l } = await sb.from("dsons_logements").select(CHAMPS).eq("slug", slug).single();
      if (!l || !reservable(l)) return json({ erreur: "Logement non réservable en ligne" }, 400);
      const d = devis(l, arrivee, depart, adultes);
      if (d.nuits.length < (l.nuits_min ?? 1)) return json({ disponible: false, raison: `Minimum ${l.nuits_min} nuit(s)` });
      const occ = await nuitsOccupees(sb, l);
      const conflit = d.nuits.filter((n) => occ.has(n));
      return json({ disponible: conflit.length === 0, conflit, ...d });
    }
    return json({ erreur: "Méthode non supportée" }, 405);
  } catch (e) {
    console.error(e);
    return json({ erreur: String((e as Error).message ?? e) }, 500);
  }
});
