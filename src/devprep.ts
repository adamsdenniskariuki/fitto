/**
 * DevPREP interview-prep pages. Ids verified against the DevPREP repo
 * (content/companies/index.json).
 */
const DEVPREP: Record<string, string> = {
  google: "google",
  alphabet: "google",
  meta: "meta",
  facebook: "meta",
  amazon: "amazon",
  aws: "amazon",
  "amazon web services": "amazon",
  microsoft: "microsoft",
  apple: "apple",
  netflix: "netflix",
  stripe: "stripe",
  uber: "uber",
  safaricom: "safaricom",
};

export function devprepLink(company: string): string | undefined {
  const key = company
    .toLowerCase()
    .replace(/[,.]|\b(inc|llc|ltd|plc|corp|corporation)\b/g, "")
    .trim();
  const id = DEVPREP[key];
  return id ? `https://devprep.madebyfavor.com/#company/${id}` : undefined;
}
