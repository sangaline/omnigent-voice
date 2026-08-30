const cancelPhrases = new Set([
  "cancel",
  "cancel it",
  "cancel that",
  "interrupt",
  "interrupt it",
  "never mind",
  "nevermind",
  "stop",
  "stop it",
  "stop that",
]);

export const normalizeSpeech = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();

export const isCancelCommand = (text: string): boolean =>
  cancelPhrases.has(normalizeSpeech(text));

export const shouldAdaptForSpeech = (text: string): boolean =>
  text.length > 420 || /```|^#{1,6}\s|\[[^\]]+\]\(|https?:\/\/|^\s*[-*]\s/m.test(text);

export const sanitizeForSpeech = (text: string, maxCharacters = 650): string => {
  let cleaned = text
    .replace(/```[\s\S]*?```/g, " I left the code out of the spoken reply. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[>*_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= maxCharacters) return cleaned;
  const prefix = cleaned.slice(0, maxCharacters);
  const sentenceEnd = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("? "), prefix.lastIndexOf("! "));
  cleaned = sentenceEnd > maxCharacters / 2 ? prefix.slice(0, sentenceEnd + 1) : `${prefix.trimEnd()}…`;
  return cleaned;
};

