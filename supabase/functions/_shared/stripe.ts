// Appels Stripe REST (sans SDK)
export async function stripe(chemin: string, params: Record<string, string> = {}, methode = "POST", idem?: string) {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Paiement non configuré (STRIPE_SECRET_KEY manquante)");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idem) headers["Idempotency-Key"] = idem;
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.stripe.com/v1/${chemin}${methode === "GET" && qs ? "?" + qs : ""}`;
  const res = await fetch(url, { method: methode, headers, body: methode === "GET" ? undefined : qs });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error("Stripe : " + (data.error?.message ?? res.status)) as Error & { stripe?: any };
    err.stripe = data.error;
    throw err;
  }
  return data;
}

// Bloque une empreinte (autorisation sans débit) sur la carte enregistrée
export async function bloquerEmpreinte(r: any, nomLogement: string, suffixe = "") {
  return await stripe("payment_intents", {
    amount: String(Math.round(Number(r.caution_montant ?? 500) * 100)),
    currency: "eur",
    customer: r.stripe_customer_id,
    payment_method: r.stripe_payment_method_id,
    capture_method: "manual",
    off_session: "true",
    confirm: "true",
    description: `Caution ${nomLogement} - ${r.ref}`,
    "metadata[ref]": r.ref,
    "metadata[type]": "caution",
  }, "POST", `caution-${r.ref}${suffixe}`);
}
