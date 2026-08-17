import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  interviewReportSchema,
  type InterviewReport
} from "./interview-report";
import {
  dataRoot,
  getDatabase,
  hasMigration,
  runTransaction
} from "./database";

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
  resumeIds: string[];
  resumeId: string;
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
  report: interviewReportSchema.nullable().default(null),
  resumeIds: z.array(z.string().max(64)).max(20).default([]),
  resumeId: z.string().max(64).default("")
}).transform((session) => {
  const resumeIds = normalizeResumeIds(session.resumeIds, session.resumeId);
  return { ...session, resumeIds, resumeId: resumeIds[0] || "" };
});

function normalizeResumeIds(resumeIds?: string[] | null, resumeId?: string | null) {
  const fromList = Array.isArray(resumeIds)
    ? resumeIds.map((id) => id.trim()).filter(Boolean)
    : [];
  const legacy = resumeId?.trim() || "";
  const merged = fromList.length > 0 ? fromList : legacy ? [legacy] : [];
  return [...new Set(merged)].slice(0, 20);
}

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
  report: null,
  resumeIds: [],
  resumeId: ""
};

const dataDirectory = path.join(dataRoot, "interviews");
const currentSessionPath = path.join(dataDirectory, "current.json");
const archiveDirectory = path.join(dataDirectory, "archive");
const legacyLocations = [
  { current: currentSessionPath, archive: archiveDirectory },
  { current: path.join(dataRoot, "current.json"), archive: path.join(dataRoot, "archive") }
];

const globalStore = globalThis as typeof globalThis & {
  interviewSession?: InterviewSession;
  interviewSessionLoading?: Promise<InterviewSession>;
  interviewMutationQueue?: Promise<unknown>;
};

function now() {
  return new Date().toISOString();
}

async function migrateLegacySessions() {
  if (hasMigration("interview-json")) return;
  let current: InterviewSession | null = null;
  const archived = new Map<string, InterviewSession>();
  for (const location of legacyLocations) {
    try {
      current ??= sessionSchema.parse(JSON.parse(await readFile(location.current, "utf8")));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("A legacy current interview file was invalid and was not imported.");
      }
    }
    let filenames: string[] = [];
    try { filenames = await readdir(location.archive); } catch { /* no legacy archive */ }
    for (const filename of filenames.filter((name) => /^[a-zA-Z0-9-]+\.json$/.test(name))) {
      try {
        const session = sessionSchema.parse(JSON.parse(
          await readFile(path.join(location.archive, filename), "utf8")
        ));
        if (session.sessionId) archived.set(session.sessionId, session);
      } catch {
        console.warn(`Legacy interview archive ${filename} was invalid and was not imported.`);
      }
    }
  }
  runTransaction(() => {
    const timestamp = now();
    if (current) {
      getDatabase().prepare(`
        INSERT INTO current_session(singleton_id, payload, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton_id) DO NOTHING
      `).run(JSON.stringify(current), timestamp);
    }
    const insertArchive = getDatabase().prepare(`
      INSERT INTO archived_sessions(session_id, finished_at, payload, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO NOTHING
    `);
    for (const session of archived.values()) {
      insertArchive.run(
        session.sessionId,
        session.finishedAt || session.startedAt || timestamp,
        JSON.stringify(session),
        timestamp
      );
    }
    getDatabase().prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES (?, 'complete', ?)
      ON CONFLICT(key) DO UPDATE SET value = 'complete', updated_at = excluded.updated_at
    `).run("migration:interview-json", timestamp);
  });
}

async function loadSessionFromDisk(): Promise<InterviewSession> {
  await migrateLegacySessions();
  const row = getDatabase().prepare(
    "SELECT payload FROM current_session WHERE singleton_id = 1"
  ).get() as { payload: string } | undefined;
  if (!row) return structuredClone(initialSession);
  try {
    return sessionSchema.parse(JSON.parse(row.payload));
  } catch {
    runTransaction(() => {
      getDatabase().prepare(`
        INSERT INTO corrupt_records(source, payload, quarantined_at) VALUES (?, ?, ?)
      `).run("current_session", row.payload, now());
      getDatabase().prepare("DELETE FROM current_session WHERE singleton_id = 1").run();
    });
    console.warn("Unreadable interview session moved to the SQLite quarantine table.");
    return await loadLatestValidArchive() ?? structuredClone(initialSession);
  }
}

async function loadLatestValidArchive(): Promise<InterviewSession | null> {
  const rows = getDatabase().prepare(
    "SELECT payload FROM archived_sessions ORDER BY finished_at DESC"
  ).all() as Array<{ payload: string }>;
  const sessions = rows.map((row) => {
    try { return sessionSchema.parse(JSON.parse(row.payload)); } catch { return null; }
  });
  return sessions
    .filter((session): session is InterviewSession => session !== null)
    .sort((left, right) =>
      (right.finishedAt || right.startedAt || "")
        .localeCompare(left.finishedAt || left.startedAt || "")
    )[0] ?? null;
}

async function persistSession(session: InterviewSession) {
  const serialized = JSON.stringify(session);
  const timestamp = now();
  runTransaction(() => {
    getDatabase().prepare(`
      INSERT INTO current_session(singleton_id, payload, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(serialized, timestamp);
    if (session.status === "finished" && session.sessionId) {
      getDatabase().prepare(`
        INSERT INTO archived_sessions(session_id, finished_at, payload, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          finished_at = excluded.finished_at,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `).run(session.sessionId, session.finishedAt || session.startedAt || timestamp, serialized, timestamp);
    }
  });
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
  resumeIds?: string[];
  resumeId?: string;
}): Promise<InterviewSession> {
  return mutateSession((previous) => {
    if (previous.status === "running") throw new Error("SESSION_ALREADY_RUNNING");
    const timestamp = now();
    const opening = `${input.candidateName || "你好"}，欢迎开始关于「${input.roleName || "本次交流"}」的互动。本次由 AI虚拟助手协助进行，对话记录会保存并由人工复核。请先用两分钟介绍一下你自己。`;
    const resumeIds = normalizeResumeIds(input.resumeIds, input.resumeId);
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
      report: null,
      resumeIds,
      resumeId: resumeIds[0] || ""
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
    const closing = "感谢你的时间，本次互动到这里。如有后续安排，相关人员会再与你联系。";
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
    const closing = "感谢你的时间，本次互动到这里。如有后续安排，相关人员会再与你联系。";
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
  await migrateLegacySessions();
  const rows = getDatabase().prepare(
    "SELECT payload FROM archived_sessions ORDER BY finished_at DESC"
  ).all() as Array<{ payload: string }>;
  const sessions = rows.map(({ payload }) => {
    try {
      const session = sessionSchema.parse(JSON.parse(payload));
      return {
        sessionId: session.sessionId,
        candidateName: session.candidateName,
        roleName: session.roleName,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        questionCount: countInterviewQuestions(session),
        reportReady: Boolean(session.report)
      };
    } catch { return null; }
  });
  return sessions
    .filter((session): session is ArchivedSessionSummary => session !== null)
    .sort((left, right) => (right.finishedAt || "").localeCompare(left.finishedAt || ""));
}

export async function getArchivedSession(sessionId: string): Promise<InterviewSession | null> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(sessionId)) return null;
  await migrateLegacySessions();
  try {
    const row = getDatabase().prepare(
      "SELECT payload FROM archived_sessions WHERE session_id = ?"
    ).get(sessionId) as { payload: string } | undefined;
    return row ? sessionSchema.parse(JSON.parse(row.payload)) : null;
  } catch {
    return null;
  }
}

export async function deleteArchivedSession(sessionId: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(sessionId)) return false;
  await migrateLegacySessions();
  const result = getDatabase().prepare(
    "DELETE FROM archived_sessions WHERE session_id = ?"
  ).run(sessionId);
  if (result.changes === 0) return false;
  const current = await getSession();
  if (current.sessionId === sessionId && current.status === "finished") {
    await mutateSession((session) => ({
      ...structuredClone(initialSession),
      revision: session.revision + 1
    }));
  }
  return true;
}
