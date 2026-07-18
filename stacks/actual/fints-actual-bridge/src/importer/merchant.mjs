export function extractCardMerchant(raw) {
  let candidate = String(raw ?? '').trim();

  const anchoredSuffixes = [
    /\s+MC\s+Hauptkarte\s*$/iu,
    /\s*Umsatz\s+vom\s+\d{2}\.\d{2}\.\d{4}\s*$/iu,
    /\s+KURS:\s*\d[\d.,]*\s+\d[\d.,]*%\s+AUSLANDSUMS\.\s*\d[\d.,]*\s*$/iu,
    /\s+[A-Z]{3}\s+\d[\d.,]*\s*$/u,
    /\s+[A-Z]{3}\s+\p{L}[\p{L}\s.'-]*\s*$/u,
  ];

  for (const suffix of anchoredSuffixes) candidate = candidate.replace(suffix, '').trim();

  const letters = candidate.match(/\p{L}/gu) ?? [];
  if (!candidate || /^\d+$/u.test(candidate) || letters.length < 3) return null;
  return candidate;
}
