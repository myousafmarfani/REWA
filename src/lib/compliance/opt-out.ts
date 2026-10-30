const OPT_OUT_PATTERNS = [
  /\b(stop|stop all|un-?sub(scribe)?s?|opt[- ]?out|cancel)\b/i,
  /\bblock\s+(me|my\s+(number|contact|details?|data))\b/i,
  /\b(don'?t|do not|never)\s+(contact|message|text|call|reach( out)?|bother|send|write)\s+(?:to\s+)?me\b/i,
  /\b(remove|delete)\s+(me|my\s+(number|contact|details?|data))\b/i,
  /\btake\s+me\s+(off|out)\b/i,
  /\btake\s+my\s+(number|contact|details?|data)\b/i,
  /\b(no more|stop sending)\s+(messages?|texts?|updates?|offers?|anything)\b/i,
  /\b(opt|unsubscribe)\s+me\s+(out|off)\b/i,
  /\bleave me alone\b/i,
  // Arabic letters are non-word chars to JS regex, so \b never matches
  // around them — match without boundaries, but keep every term in
  // opt-out context so ordinary sentences ("when does construction
  // halt?") do not trip the check.
  /(إلغاء الاشتراك|لا ترسل|لا تراسلني|لا تتواصل معي|إيقاف الرسائل|ايقاف الرسائل|أوقف الرسائل|توقف عن إرسال|توقف عن مراسلتي|احذف رقمي|احذفني|لا أريد رسائل)/i,
];

export function isOptOut(message: string): boolean {
  return OPT_OUT_PATTERNS.some((re) => re.test(message.trim()));
}
