const maxInjectCharacters = 4000;
const maxQueryRunes = 2000;

type KnowledgeChunk = {
  content?: string;
  score?: number;
  candidateName?: string;
};

export function buildKnowledgeQuery(lastQuestion: string, answer: string) {
  const combined = [lastQuestion, answer].map((part) => part.trim()).filter(Boolean).join("\n");
  return Array.from(combined).slice(0, maxQueryRunes).join("");
}

function normalizeResumeIds(resumeIds: string | string[] | undefined) {
  if (Array.isArray(resumeIds)) {
    return [...new Set(resumeIds.map((id) => id.trim()).filter(Boolean))];
  }
  const single = typeof resumeIds === "string" ? resumeIds.trim() : "";
  return single ? [single] : [];
}

export async function searchResumeKnowledge(resumeIds: string | string[], query: string) {
  const ids = normalizeResumeIds(resumeIds);
  const text = query.trim();
  if (ids.length === 0 || !text) {
    return "";
  }
  try {
    const response = await fetch("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: text,
        resumeIds: ids,
        resumeId: ids[0],
        topK: 5
      }),
      cache: "no-store"
    });
    if (!response.ok) {
      return "";
    }
    const payload = await response.json().catch(() => null) as { chunks?: KnowledgeChunk[] } | null;
    const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
    let combined = "";
    for (const chunk of chunks) {
      const content = typeof chunk.content === "string" ? chunk.content.trim() : "";
      if (!content) {
        continue;
      }
      const next = combined ? `${combined}\n\n${content}` : content;
      if (Array.from(next).length > maxInjectCharacters) {
        break;
      }
      combined = next;
    }
    return combined;
  } catch {
    return "";
  }
}
