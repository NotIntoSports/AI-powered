export function normalizeInterviewQuestion(value: string) {
  return Array.from(value.toLowerCase())
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
}

function bigrams(value: string) {
  const characters = Array.from(value);
  if (characters.length < 2) return new Set(characters);
  return new Set(characters.slice(0, -1).map((character, index) =>
    character + characters[index + 1]
  ));
}

export function isSubstantiallyDuplicateQuestion(
  candidate: string,
  previousQuestions: string[]
) {
  const normalizedCandidate = normalizeInterviewQuestion(candidate);
  if (!normalizedCandidate) return false;
  const candidateBigrams = bigrams(normalizedCandidate);

  return previousQuestions.some((previous) => {
    const normalizedPrevious = normalizeInterviewQuestion(previous);
    if (!normalizedPrevious) return false;
    if (normalizedCandidate === normalizedPrevious) return true;
    if (
      normalizedCandidate.includes(normalizedPrevious) ||
      normalizedPrevious.includes(normalizedCandidate)
    ) {
      const shorter = Math.min(normalizedCandidate.length, normalizedPrevious.length);
      const longer = Math.max(normalizedCandidate.length, normalizedPrevious.length);
      if (shorter / longer >= 0.72) return true;
    }
    const previousBigrams = bigrams(normalizedPrevious);
    const intersection = [...candidateBigrams]
      .filter((gram) => previousBigrams.has(gram))
      .length;
    const union = new Set([...candidateBigrams, ...previousBigrams]).size;
    return union > 0 && intersection / union >= 0.72;
  });
}

const fallbackQuestions = [
  "请换一个不同的具体案例，说明你的个人贡献和量化结果？",
  "当时最关键的取舍是什么，你为什么这样决定？",
  "这个过程中出现过什么意外问题，你是如何定位并解决的？",
  "如果重新做一次，你会改变哪项做法，为什么？",
  "你如何验证最终结果确实由这些措施带来？"
];

export function pickNonDuplicateFallback(previousQuestions: string[]) {
  return fallbackQuestions.find((question) =>
    !isSubstantiallyDuplicateQuestion(question, previousQuestions)
  ) || "请补充一个尚未提到的工作细节，并说明你个人采取的行动？";
}
