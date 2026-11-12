// GET  ?            → liste des logements (vitrine)
// GET  ?slug=xxx    → logement + nuits occupées, prix par nuit et règles (12 mois), lus dans le calendrier SuperHote
// POST {slug, arrivee, depart, adultes} → devis + disponibilité
// Les prix suivent PriceLabs : PriceLabs → SuperHote → ce site.
import { admin, calendrierSuperHote, cors, devis, iso, json, nuitsEntre, nuitsOccupees, prixNuit, regleSejour, remiseSite, reservable } from "../_shared/commun.ts";

const CHAMPS =
  "slug,nom,ville,capacite,menage,taxe_sejour_pp,prix_semaine,prix_weekend,nuits_min,description,equipements,photos,arrivee_heure,depart_heure,ordre,ical_url,superhote_id,actif,titre,description_longue,chambres,lits,salles_de_bain,note,nb_avis,latitude,longitude,options";

const publicLogement = (l: any, prixMin?: number) => {
  const { ical_url, superhote_id, ...reste } = l;
  return { ...reste, reservable: reservable(l), ...(prixMin ? { prix_min: prixMin } : {}) };
};
const un_an = () => iso(new Date(Date.now() + 366 * 86400000));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = admin();
  try {
    if (req.method === "GET") {
      const slug = new URL(req.url).searchParams.get("slug");
      const remise = await remiseSite(sb);
      if (!slug) {
        const { data, error } = await sb.from("dsons_logements").select(CHAMPS).eq("actif", true).order("ordre");
        if (error) throw error;
        // Prix « à partir de » sur les 60 prochains jours libres
        const logements = await Promise.all(data.map(async (l: any) => {
          if (!reservable(l) || !l.superhote_id) return publicLogement(l);
          try {
            const cal = await calendrierSuperHote(l, iso(new Date()), iso(new Date(Date.now() + 60 * 86400000)));
            const libres = [...cal].filter(([, n]) => n.dispo && n.prix).map(([d]) => prixNuit(l, d, cal, remise));
            return publicLogement(l, libres.length ? Math.min(...libres) : undefined);
          } catch { return publicLogement(l); }
        }));
        return json({ logements });
      }
      const { data: l } = await sb.from("dsons_logements").select(CHAMPS).eq("slug", slug).single();
      if (!l) return json({ erreur: "Logement introuvable" }, 404);
      let occupees: string[] = [];
      const prix: Record<string, number> = {};
      const min_nuits: Record<string, number> = {};
      const sans_arrivee: string[] = [], sans_depart: string[] = [];
      if (reservable(l)) {
        const cal = l.superhote_id ? await calendrierSuperHote(l, iso(new Date()), un_an()) : undefined;
        occupees = [...(await nuitsOccupees(sb, l, cal))];
        for (const n of nuitsEntre(iso(new Date()), un_an())) {
          prix[n] = prixNuit(l, n, cal, remise);
          const j = cal?.get(n);
          if (j && j.min > 1) min_nuits[n] = j.min;
          if (j?.sansArrivee) sans_arrivee.push(n);
          if (j?.sansDepart) sans_depart.push(n);
        }
      }
      const libres = Object.entries(prix).filter(([d]) => !occupees.includes(d)).map(([, p]) => p).filter(Boolean);
      return json({ logement: publicLogement(l, libres.length ? Math.min(...libres) : undefined), occupees, prix, min_nuits, sans_arrivee, sans_depart });
    }

    if (req.method === "POST") {
      const { slug, arrivee, depart, adultes = 1 } = await req.json();
      const { data: l } = await sb.from("dsons_logements").select(CHAMPS).eq("slug", slug).single();
      if (!l || !reservable(l)) return json({ erreur: "Logement non réservable en ligne" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(arrivee ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(depart ?? "") || depart <= arrivee) return json({ erreur: "Dates invalides" }, 400);
      const cal = l.superhote_id ? await calendrierSuperHote(l, arrivee, depart) : undefined;
      const regle = regleSejour(cal, arrivee, depart, l.nuits_min ?? 1);
      if (regle) return json({ disponible: false, raison: regle });
      const d = devis(l, arrivee, depart, adultes, cal, await remiseSite(sb));
      const occ = await nuitsOccupees(sb, l, cal);
      const conflit = d.nuits.filter((n) => occ.has(n));
      return json({ disponible: conflit.length === 0, conflit, ...d });
    }
    return json({ erreur: "Méthode non supportée" }, 405);
  } catch (e) {
    console.error(e);
    return json({ erreur: String((e as Error).message ?? e) }, 500);
  }
});
