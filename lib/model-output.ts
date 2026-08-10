const HIDDEN_BLOCKS = ["think", "reasoning"];

export function stripHiddenReasoning(content: string) {
  let cleaned = content;
  for (const tag of HIDDEN_BLOCKS) {
    const closedBlock = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    cleaned = cleaned.replace(closedBlock, "");

    const unclosedBlock = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i");
    cleaned = cleaned.replace(unclosedBlock, "");

    const remainingTag = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
    cleaned = cleaned.replace(remainingTag, "");
  }
  return cleaned.trim();
}

export function sanitizeInterviewQuestion(content: string) {
  let cleaned = stripHiddenReasoning(content)
    .replace(/```(?:\w+)?/g, "")
    .replace(/```/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)、])\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/^\s*(?:问题|面试官|追问)(?:\s*[：:]\s*|\s+)/i, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) throw new Error("EMPTY_MODEL_RESPONSE");

  const questionMark = cleaned.search(/[？?]/);
  const sentenceEnd = cleaned.search(/[。！!]/);
  const end = questionMark >= 0 ? questionMark : sentenceEnd;
  if (end >= 0) cleaned = cleaned.slice(0, end + 1).trim();

  cleaned = cleaned.replace(/[。！!]+$/, "");
  if (!/[？?]$/.test(cleaned)) cleaned += "？";

  const codePoints = Array.from(cleaned);
  if (codePoints.length > 80) {
    cleaned = codePoints.slice(0, 79).join("").replace(/[，,、；;：:\s]+$/, "") + "？";
  }
  if (!cleaned || cleaned === "？") throw new Error("EMPTY_MODEL_RESPONSE");
  return cleaned;
}

const SENSITIVE_HIRING_PATTERNS = [
  /(?:你|您)(?:的|今年)?(?:多大|几岁|年龄|哪年出生|属什么)/i,
  /(?:你|您)(?:结婚|已婚|未婚)了吗/i,
  /(?:你|您).*(?:是否|有没有|有无|计划|打算).*(?:结婚|怀孕|备孕|生育|要孩子|生孩子|二胎)/i,
  /(?:你|您).*(?:结婚|怀孕|备孕|生育|要孩子|生孩子|二胎).*(?:计划|打算)/i,
  /(?:你|您)(?:有|有没有).*(?:孩子|小孩|对象|男朋友|女朋友)/i,
  /(?:你|您)(?:本人)?的?(?:民族|宗教(?:信仰)?|信仰|政治面貌|党派|性取向|性别认同|户籍|籍贯)(?:是|为|属于|什么|哪里)/i,
  /(?:你|您)(?:本人)?的?(?:身体(?:健康)?状况|健康状况|病史|残疾情况|残障情况|遗传病)/i,
  /(?:你|您).*(?:是否|有没有|有无).*(?:疾病|病史|残疾|残障|遗传病)/i,
  /(?:父母|家人|配偶).*(?:职业|工作|做什么)/i,
  /(?:介绍|说说).*(?:家庭情况|家庭背景)/i
];

export function isSensitiveHiringQuestion(question: string) {
  return SENSITIVE_HIRING_PATTERNS.some((pattern) => pattern.test(question));
}
