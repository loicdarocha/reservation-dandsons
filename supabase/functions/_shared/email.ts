export const eur = (n: number | string) => Number(n ?? 0).toFixed(2).replace(".", ",") + " €";
export const dateFr = (s: string) =>
  new Date(s + "T00:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });

export const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function envoyerEmail(to: string[], sujet: string, html: string, pieces: { filename: string; content: string }[] = []) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.warn("RESEND_API_KEY absente : email non envoyé"); return; }
  const from = Deno.env.get("EMAIL_EXPEDITEUR") ?? "D and Sons <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: sujet, html, attachments: pieces }),
  });
  if (!res.ok) console.error("Resend", res.status, await res.text());
}
