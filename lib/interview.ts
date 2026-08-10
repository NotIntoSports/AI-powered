import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  interviewReportSchema,
  type InterviewReport
} from "./interview-report";

export type TranscriptItem = {
  role: "interviewer" | "candidate";
  kind?: "opening" | "question" | "manual" | "answer" | "closing";
  text: string;
  at: string;
};

export type InterviewSession = {
  sessionId: string;
  revision: number;
  status: "idle" | "running" | "finished";
  speakingText: string;
  candidateName: string;
  roleName: string;
  jobDescription: string;
  interviewFocus: string;
  maxQuestions: number;
  consentConfirmed: boolean;
  consentConfirmedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  transcript: TranscriptItem[];
  report: InterviewReport | null;
};

const transcriptItemSchema = z.object({
  role: z.enum(["interviewer", "candidate"]),
  kind: z.enum(["opening", "question", "manual", "answer", "closing"]).optional(),
  text: z.string(),
  at: z.string().default(() => new Date().toISOString())
});

const sessionSchema = z.object({
  sessionId: z.string().default(""),
  revision: z.number().int().nonnegative(),
  status: z.enum(["idle", "running", "finished"]),
  speakingText: z.string(),
  candidateName: z.string(),
  roleName: z.string(),
  jobDescription: z.string().default(""),
  interviewFocus: z.string().default(""),
  maxQuestions: z.number().int().min(2).max(20).default(6),
  consentConfirmed: z.boolean().default(false),
  consentConfirmedAt: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  transcript: z.array(transcriptItemSchema),
  report: interviewReportSchema.nullable().default(null)
});

const initialSession: InterviewSession = {
  sessionId: "",
  revision: 0,
  status: "idle",
  speakingText: "",
  candidateName: "",
  roleName: "",
  jobDescription: "",
  interviewFocus: "",
  maxQuestions: 6,
  consentConfirmed: false,
  consentConfirmedAt: null,
  startedAt: null,
  finishedAt: null,
  transcript: [],
  report: null
};

const dataDirectory = process.env.INTERVIEW_DATA_DIR
  ? path.resolve(process.env.INTERVIEW_DATA_DIR)
  : path.join(process.cwd(), "data", "interviews");
const currentSessionPath = path.join(dataDirectory, "current.json");
const archiveDirectory = path.join(dataDirectory, "archive");

const globalStore = globalThis as typeof globalThis & {
  interviewSession?: InterviewSession;
  interviewSessionLoading?: Promise<InterviewSession>;
  interviewMutationQueue?: Promise<unknown>;
};

function now() {
  return new Date().toISOString();
}

async function loadSessionFromDisk(): Promise<InterviewSession> {
  let serialized: string;
  try {
    serialized = await readFile(currentSessionPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return structuredClone(initialSession);
  }
  try {
    return sessionSchema.parse(JSON.parse(serialized));
  } catch {
    await mkdir(dataDirectory, { recursive: true });
    const corruptBackupPath = path.join(
      dataDirectory,
      `current.corrupt.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.json`
    );
    // Never continue with an empty session unless the unreadable source has
    // first been moved aside successfully for manual recovery.
    await rename(currentSessionPath, corruptBackupPath);
    console.warn(`Unreadable interview session moved to ${path.basename(corruptBackupPath)}`);
    return await loadLatestValidArchive() ?? structuredClone(initialSession);
  }
}

async function loadLatestValidArchive(): Promise<InterviewSession | null> {
  let filenames: string[];
  try {
    filenames = await readdir(archiveDirectory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  const sessions = await Promise.all(
    filenames
      .filter((filename) => /^[a-zA-Z0-9-]+\.json$/.test(filename))
      .map(async (filename) => {
        try {
          return sessionSchema.parse(JSON.parse(
            await readFile(path.join(archiveDirectory, filename), "utf8")
          ));
        } catch {
          return null;
        }
      })
  );
  return sessions
    .filter((session): session is InterviewSession => session !== null)
    .sort((left, right) =>
      (right.finishedAt || right.startedAt || "")
        .localeCompare(left.finishedAt || left.startedAt || "")
    )[0] ?? null;
}

async function persistSession(session: InterviewSession) {
  await mkdir(dataDirectory, { recursive: true });
  const serialized = `${JSON.stringify(session, null, 2)}\n`;
  const temporaryPath = `${currentSessionPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, serialized, "utf8");
  await rename(temporaryPath, currentSessionPath);
  if (session.status === "finished" && session.sessionId) {
    await mkdir(archiveDirectory, { recursive: true });
    const archivePath = path.join(archiveDirectory, `${session.sessionId}.json`);
    const archiveTemporaryPath = `${archivePath}.${process.pid}.tmp`;
    await writeFile(archiveTemporaryPath, serialized, "utf8");
    await rename(archiveTemporaryPath, archivePath);
  }
}

async function mutateSession(
  mutation: (session: InterviewSession) => void | InterviewSession
): Promise<InterviewSession> {
  const previous = globalStore.interviewMutationQueue ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const current = await getSession();
    const replacement = mutation(current);
    const session = replacement ?? current;
    globalStore.interviewSession = session;
    await persistSession(session);
    return session;
  });
  globalStore.interviewMutationQueue = next;
  return next;
}

export async function getSession(): Promise<InterviewSession> {
  if (globalStore.interviewSession) return globalStore.interviewSession;
  globalStore.interviewSessionLoading ??= loadSessionFromDisk().then((session) => {
    globalStore.interviewSession = session;
    return session;
  });
  return globalStore.interviewSessionLoading;
}

export function resetSession(input: {
  candidateName: string;
  roleName: string;
  jobDescription: string;
  interviewFocus: string;
  maxQuestions: number;
  consentConfirmed: true;
}): Promise<InterviewSession> {
  return mutateSession((previous) => {
    if (previous.status === "running") throw new Error("SESSION_ALREADY_RUNNING");
    const timestamp = now();
    const opening = `${input.candidateName || "你好"}，欢迎参加${input.roleName || "本岗位"}面试。本次由 AI 面试官协助进行，招聘人员会人工复核面试记录。请先用两分钟介绍一下你自己。`;
    return {
      sessionId: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      revision: previous.revision + 1,
      status: "running",
      speakingText: opening,
      candidateName: input.candidateName,
      roleName: input.roleName,
      jobDescription: input.jobDescription,
      interviewFocus: input.interviewFocus,
      maxQuestions: input.maxQuestions,
      consentConfirmed: true,
      consentConfirmedAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
      transcript: [{ role: "interviewer", kind: "opening", text: opening, at: timestamp }],
      report: null
    };
  });
}

export function countInterviewQuestions(session: Pick<InterviewSession, "transcript">) {
  return session.transcript.filter((item) =>
    item.role === "interviewer" &&
    item.kind !== "manual" &&
    item.kind !== "closing"
  ).length;
}

export function hasReachedQuestionLimit(session: InterviewSession) {
  return countInterviewQuestions(session) >= session.maxQuestions;
}

export function appendInterviewerQuestion(
  question: string,
  kind: "question" | "manual" = "question"
): Promise<InterviewSession> {
  return mutateSession((session) => {
    if (session.status !== "running") throw new Error("SESSION_NOT_RUNNING");
    session.transcript.push({ role: "interviewer", kind, text: question, at: now() });
    session.speakingText = question;
    session.revision += 1;
  });
}

function assertExpectedTurn(session: InterviewSession, expectedRevision: number) {
  if (session.status !== "running") throw new Error("SESSION_NOT_RUNNING");
  if (
    session.revision !== expectedRevision ||
    session.transcript.at(-1)?.role !== "interviewer"
  ) {
    throw new Error("SESSION_CHANGED");
  }
}

export function appendAnswerAndQuestion(input: {
  answer: string;
  question: string;
  expectedRevision: number;
}): Promise<InterviewSession> {
  return mutateSession((session) => {
    assertExpectedTurn(session, input.expectedRevision);
    if (hasReachedQuestionLimit(session)) throw new Error("SESSION_CHANGED");
    const timestamp = now();
    session.transcript.push(
      { role: "candidate", kind: "answer", text: input.answer, at: timestamp },
      { role: "interviewer", kind: "question", text: input.question, at: timestamp }
    );
    session.speakingText = input.question;
    session.revision += 1;
  });
}

export function appendFinalAnswerAndFinish(input: {
  answer: string;
  expectedRevision: number;
}): Promise<InterviewSession> {
  return mutateSession((session) => {
    assertExpectedTurn(session, input.expectedRevision);
    if (!hasReachedQuestionLimit(session)) throw new Error("SESSION_CHANGED");
    const timestamp = now();
    const closing = "感谢你的时间，本次面试到这里。后续结果会由招聘团队与你联系。";
    session.transcript.push(
      { role: "candidate", kind: "answer", text: input.answer, at: timestamp },
      { role: "interviewer", kind: "closing", text: closing, at: timestamp }
    );
    session.status = "finished";
    session.finishedAt = timestamp;
    session.speakingText = closing;
    session.revision += 1;
  });
}

export function replaceLastInterviewerQuestion(input: {
  question: string;
  expectedRevision: number;
  expectedQuestionAt: string;
}): Promise<InterviewSession> {
  return mutateSession((session) => {
    if (session.status !== "running") throw new Error("SESSION_NOT_RUNNING");
    const lastIndex = session.transcript.length - 1;
    if (
      lastIndex < 1 ||
      session.revision !== input.expectedRevision ||
      session.transcript[lastIndex].role !== "interviewer" ||
      session.transcript[lastIndex].at !== input.expectedQuestionAt ||
      !session.transcript.slice(0, lastIndex).some((item) => item.role === "candidate")
    ) {
      throw new Error("NO_RETRYABLE_QUESTION");
    }
    session.transcript[lastIndex] = {
      role: "interviewer",
      kind: "question",
      text: input.question,
      at: now()
    };
    session.speakingText = input.question;
    session.revision += 1;
  });
}

export function replaceLastExchange(input: {
  answer: string;
  question: string;
  expectedAnswerAt: string;
  expectedQuestionAt: string;
}): Promise<InterviewSession> {
  return mutateSession((session) => {
    if (session.status !== "running") throw new Error("SESSION_NOT_RUNNING");
    const questionIndex = session.transcript.length - 1;
    const answerIndex = questionIndex - 1;
    const currentAnswer = session.transcript[answerIndex];
    const currentQuestion = session.transcript[questionIndex];
    if (
      answerIndex < 0 ||
      currentAnswer?.role !== "candidate" ||
      currentQuestion?.role !== "interviewer" ||
      currentAnswer.at !== input.expectedAnswerAt ||
      currentQuestion.at !== input.expectedQuestionAt
    ) {
      throw new Error("SESSION_CHANGED");
    }
    session.transcript[answerIndex] = {
      role: "candidate",
      kind: "answer",
      text: input.answer,
      at: currentAnswer.at
    };
    session.transcript[questionIndex] = {
      role: "interviewer",
      kind: "question",
      text: input.question,
      at: now()
    };
    session.speakingText = input.question;
    session.revision += 1;
  });
}

export function finishSession(): Promise<InterviewSession> {
  return mutateSession((session) => {
    if (session.status !== "running") throw new Error("SESSION_NOT_RUNNING");
    const timestamp = now();
    const closing = "感谢你的时间，本次面试到这里。后续结果会由招聘团队与你联系。";
    session.status = "finished";
    session.finishedAt = timestamp;
    session.transcript.push({
      role: "interviewer",
      kind: "closing",
      text: closing,
      at: timestamp
    });
    session.speakingText = closing;
    session.revision += 1;
  });
}

export function setInterviewReport(report: InterviewReport): Promise<InterviewSession> {
  return mutateSession((session) => {
    if (session.status !== "finished") throw new Error("SESSION_NOT_FINISHED");
    session.report = report;
  });
}

export type ArchivedSessionSummary = Pick<
  InterviewSession,
  "sessionId" | "candidateName" | "roleName" | "startedAt" | "finishedAt"
> & {
  questionCount: number;
  reportReady: boolean;
};

export async function listArchivedSessions(): Promise<ArchivedSessionSummary[]> {
  let filenames: string[];
  try {
    filenames = await readdir(archiveDirectory);
  } catch {
    return [];
  }
  const sessions = await Promise.all(filenames
    .filter((filename) => /^[a-zA-Z0-9-]+\.json$/.test(filename))
    .map(async (filename) => {
      try {
        const session = sessionSchema.parse(JSON.parse(
          await readFile(path.join(archiveDirectory, filename), "utf8")
        ));
        return {
          sessionId: session.sessionId,
          candidateName: session.candidateName,
          roleName: session.roleName,
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          questionCount: countInterviewQuestions(session),
          reportReady: Boolean(session.report)
        };
      } catch {
        return null;
      }
    }));
  return sessions
    .filter((session): session is ArchivedSessionSummary => session !== null)
    .sort((left, right) => (right.finishedAt || "").localeCompare(left.finishedAt || ""));
}

export async function getArchivedSession(sessionId: string): Promise<InterviewSession | null> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(sessionId)) return null;
  try {
    return sessionSchema.parse(JSON.parse(
      await readFile(path.join(archiveDirectory, `${sessionId}.json`), "utf8")
    ));
  } catch {
    return null;
  }
}

export async function deleteArchivedSession(sessionId: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(sessionId)) return false;
  const archivePath = path.join(archiveDirectory, `${sessionId}.json`);
  try {
    await unlink(archivePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
  const current = await getSession();
  if (current.sessionId === sessionId && current.status === "finished") {
    await mutateSession((session) => ({
      ...structuredClone(initialSession),
      revision: session.revision + 1
    }));
  }
  return true;
}
