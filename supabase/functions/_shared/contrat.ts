import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const eur = (n: number) => n.toFixed(2).replace(".", ",") + " €";
const dateFr = (s: string) => new Date(s + "T00:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC" });

// Le texte reste en Latin-1 pour la police standard Helvetica
const clean = (s: string) =>
  String(s ?? "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x00-\xFF€]/g, "");

export function articlesContrat(p: Record<string, string>, l: any) {
  return [
    ["1. Objet", `Le bailleur loue au locataire, qui l'accepte, le logement meublé "${l.nom}" situé à ${l.ville}, à usage exclusif d'habitation temporaire et de loisirs (location saisonnière, articles 1713 et suivants du Code civil). Le locataire ne pourra en aucun cas se prévaloir d'un droit au maintien dans les lieux.`],
    ["2. Durée et horaires", `Arrivée à partir de ${l.arrivee_heure ?? "16:00"}, départ au plus tard à ${l.depart_heure ?? "10:00"}. Les codes d'accès sont transmis la veille ou le jour de l'arrivée.`],
    ["3. Capacité", `Le logement est loué pour ${l.capacite} personne(s) maximum. Toute personne supplémentaire non déclarée pourra entraîner la résiliation immédiate sans remboursement.`],
    ["4. Prix et paiement", "Le prix total indiqué ci-dessus est réglé intégralement en ligne à la réservation. La réservation n'est ferme qu'après encaissement."],
    ["5. Annulation", p.annulation ?? "Annulation gratuite jusqu'à 7 jours avant la date d'arrivée (remboursement intégral). Au-delà, le montant du séjour reste acquis au bailleur, sauf relocation des mêmes dates."],
    ["6. Dépôt de garantie", p.caution ?? "Aucun dépôt de garantie n'est encaissé à la réservation. Le bailleur se réserve le droit de facturer au locataire, sur justificatifs, toute dégradation constatée à son départ."],
    ["7. Obligations du locataire", "Le locataire use paisiblement du logement et des équipements, respecte la tranquillité du voisinage, ne fume pas à l'intérieur, n'organise aucune fête ni événement, et n'introduit pas d'animaux sans accord écrit. Il signale sans délai tout dommage ou dysfonctionnement."],
    ["8. Équipements de bien-être", "Le spa, la salle cinéma et autres équipements sont utilisés sous la responsabilité exclusive du locataire, dans le respect des consignes affichées. Leur usage est déconseillé aux femmes enceintes et aux personnes souffrant de troubles cardiaques sans avis médical."],
    ["9. État des lieux et ménage", "Le logement est remis propre et en bon état. Le locataire le restitue rangé, vaisselle faite et poubelles sorties. Toute dégradation ou ménage exceptionnel pourra être facturé."],
    ["10. Assurance", "Le locataire déclare être couvert par une assurance responsabilité civile villégiature pour la durée du séjour."],
    ["11. Pièces d'identité", "Conformément à l'article R.814-1 du CESEDA (fiche de police pour les voyageurs étrangers) et pour la sécurité du séjour, le locataire transmet une pièce d'identité valide. Ces données sont conservées de manière sécurisée et supprimées au plus tard 6 mois après le séjour."],
    ["12. Litiges", "Le présent contrat est soumis au droit français. En cas de litige, les parties recherchent une solution amiable avant toute action devant le tribunal compétent du lieu du logement."],
  ];
}

export async function genererContratPdf(opts: {
  params: Record<string, string>;
  logement: any;
  resa: any;
  signaturePng?: Uint8Array;
}) {
  const { params: p, logement: l, resa: r } = opts;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const terre = rgb(0.62, 0.3, 0.19);
  const gris = rgb(0.25, 0.25, 0.25);
  let page = pdf.addPage([595, 842]);
  let y = 790;
  const M = 50, W = 495;

  const nouvellePageSi = (h: number) => {
    if (y - h < 60) { page = pdf.addPage([595, 842]); y = 790; }
  };
  const texte = (t: string, size = 9.5, f = font, color = gris, interligne = 1.45) => {
    const mots = clean(t).split(/\s+/);
    let ligne = "";
    const lignes: string[] = [];
    for (const m of mots) {
      const test = ligne ? ligne + " " + m : m;
      if (f.widthOfTextAtSize(test, size) > W) { lignes.push(ligne); ligne = m; } else ligne = test;
    }
    if (ligne) lignes.push(ligne);
    for (const li of lignes) {
      nouvellePageSi(size * interligne);
      page.drawText(li, { x: M, y, size, font: f, color });
      y -= size * interligne;
    }
  };
  const ligneKV = (k: string, v: string) => {
    nouvellePageSi(14);
    page.drawText(clean(k), { x: M, y, size: 9.5, font: bold, color: gris });
    page.drawText(clean(v), { x: M + 150, y, size: 9.5, font, color: gris });
    y -= 14;
  };

  page.drawText("CONTRAT DE LOCATION SAISONNIÈRE", { x: M, y, size: 16, font: bold, color: terre });
  y -= 18;
  texte(`Référence ${r.ref} - établi le ${new Date().toLocaleDateString("fr-FR")}`, 9);
  y -= 10;

  texte("ENTRE LES SOUSSIGNÉS", 10.5, bold, terre); y -= 2;
  texte(`${p.raison_sociale}, ${p.adresse_societe}, SIRET ${p.siret}, représentée par Loïc Da Rocha - ${p.telephone_hote} - ${p.email_hote}, ci-après "le bailleur",`);
  y -= 4;
  texte(`et ${r.prenom} ${r.nom}, ${[r.adresse, r.code_postal, r.ville, r.pays].filter(Boolean).join(", ")} - ${r.telephone} - ${r.email}, ci-après "le locataire".`);
  y -= 12;

  texte("LE SÉJOUR", 10.5, bold, terre); y -= 2;
  ligneKV("Logement", `${l.nom} - ${l.ville}`);
  ligneKV("Arrivée", `${dateFr(r.arrivee)} à partir de ${l.arrivee_heure ?? "16:00"}`);
  ligneKV("Départ", `${dateFr(r.depart)} avant ${l.depart_heure ?? "10:00"}`);
  ligneKV("Voyageurs", `${r.adultes} adulte(s)${r.enfants ? `, ${r.enfants} enfant(s)` : ""}`);
  y -= 6;
  ligneKV("Hébergement", eur(Number(r.montant_nuits)));
  if (Number(r.montant_menage)) ligneKV("Frais de ménage", eur(Number(r.montant_menage)));
  if (Number(r.montant_taxe)) ligneKV("Taxe de séjour", eur(Number(r.montant_taxe)));
  nouvellePageSi(18);
  page.drawText("TOTAL TTC", { x: M, y, size: 11, font: bold, color: terre });
  page.drawText(eur(Number(r.montant_total)), { x: M + 150, y, size: 11, font: bold, color: terre });
  y -= 22;

  for (const [titre, corps] of articlesContrat(p, l)) {
    nouvellePageSi(30);
    texte(titre, 10, bold, terre, 1.6);
    texte(corps);
    y -= 6;
  }

  nouvellePageSi(150);
  y -= 8;
  texte("SIGNATURE DU LOCATAIRE", 10.5, bold, terre);
  texte(`Signé électroniquement le ${new Date(r.contrat_signe_le ?? Date.now()).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} (heure de Paris) depuis l'adresse IP ${r.signature_ip ?? "-"}. Le locataire reconnaît avoir lu et accepté l'ensemble des conditions ci-dessus ("Lu et approuvé").`, 8.5);
  if (opts.signaturePng) {
    const img = await pdf.embedPng(opts.signaturePng);
    const h = 70, w = Math.min(220, (img.width / img.height) * h);
    page.drawImage(img, { x: M, y: y - h - 4, width: w, height: h });
    y -= h + 12;
  }

  return await pdf.save();
}
