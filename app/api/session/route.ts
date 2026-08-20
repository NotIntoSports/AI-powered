import { NextResponse } from "next/server";
import { z } from "zod";
import {
  appendAnswerAndQuestion,
  appendFinalAnswerAndFinish,
  appendInterviewerQuestion,
  finishSession,
  getSession,
  hasReachedQuestionLimit,
  replaceLastExchange,
  replaceLastInterviewerQuestion,
  resetSession,
  setInterviewReport
} from "../../../lib/interview";
import { generateInterviewReport, generateNextQuestion } from "../../../lib/llm";
import { buildKnowledgeQuery, searchResumeKnowledge } from "../../../lib/knowledge";
import {
  getModelRuntimeConfig,
  isModelRuntimeConfigured
} from "../../../lib/runtime-config";
import { probeConfiguredModel } from "../../../lib/model-probe";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    candidateName: z.string().trim().max(50),
    roleName: z.string().trim().max(100),
    jobDescription: z.string().trim().max(3000).default(""),
    interviewFocus: z.string().trim().max(500).default(""),
    maxQuestions: z.number().int().min(2).max(20).default(6),
    consentConfirmed: z.literal(true),
    resumeIds: z.array(z.string().trim().max(64)).max(20).optional().default([]),
    resumeId: z.string().trim().max(64).optional().default("")
  }),
  z.object({
    action: z.literal("answer"),
    answer: z.string().trim().min(1).max(4000),
    expectedRevision: z.number().int().nonnegative()
  }),
  z.object({
    action: z.literal("say"),
    text: z.string().trim().min(1).max(500)
  }),
  z.object({
    action: z.literal("retryQuestion"),
    expectedRevision: z.number().int().nonnegative()
  }),
  z.object({
    action: z.literal("correctLastAnswer"),
    answer: z.string().trim().min(1).max(4000)
  }),
  z.object({ action: z.literal("finish") }),
  z.object({ action: z.literal("generateReport") })
]);

function lastInterviewerText(transcript: { role: string; text: string }[]) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index].role === "interviewer") {
      return transcript[index].text;
    }
  }
  return "";
}

async function knowledgeContextFor(
  resumeIds: string[] | undefined,
  transcript: { role: string; text: string }[],
  answer: string
) {
  const ids = Array.isArray(resumeIds) ? resumeIds.map((id) => id.trim()).filter(Boolean) : [];
  if (ids.length === 0) {
    return "";
  }
  return searchResumeKnowledge(ids, buildKnowledgeQuery(lastInterviewerText(transcript), answer));
}

function lastCandidateText(transcript: { role: string; text: string }[]) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index].role === "candidate") {
      return transcript[index].text;
    }
  }
  return "";
}

export async function GET() {
  return NextResponse.json(await getSession(), {
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    console.warn("[session] invalid action payload");
    return NextResponse.json(
      { code: "INVALID_INPUT", message: "提交内容不符合要求" },
      { status: 422 }
    );
  }

  try {
    if (parsed.data.action === "start") {
      const current = await getSession();
      if (current.status === "running") {
        return NextResponse.json(
          { code: "SESSION_ALREADY_RUNNING", message: "请先结束当前互动，再开始新互动" },
          { status: 409 }
        );
      }
      const runtime = await getModelRuntimeConfig();
      if (!isModelRuntimeConfigured(runtime)) {
        return NextResponse.json(
          {
            code: "MODEL_NOT_CONFIGURED",
            message: "请先配置远程模型密钥，或启用本机无密钥模型"
          },
          { status: 503 }
        );
      }
      const probe = await probeConfiguredModel();
      if (!probe.reachable) {
        return NextResponse.json(
          {
            code: "MODEL_UNREACHABLE",
            message: `模型服务不可用：${probe.message}`
          },
          { status: 503 }
        );
      }
      if (!probe.modelFound) {
        return NextResponse.json(
          {
            code: "MODEL_NOT_FOUND",
            message: probe.message
          },
          { status: 409 }
        );
      }
      const started = await resetSession(parsed.data);
      console.log(`[session] started sessionId=${started.sessionId} elapsedMs=${Date.now() - startedAt}`);
      return NextResponse.json(started);
    }
    if (parsed.data.action === "say") {
      return NextResponse.json(await appendInterviewerQuestion(parsed.data.text, "manual"));
    }
    if (parsed.data.action === "finish") {
      return NextResponse.json(await finishSession());
    }
    if (parsed.data.action === "retryQuestion") {
      const session = await getSession();
      const lastItem = session.transcript.at(-1);
      if (
        session.status !== "running" ||
        session.revision !== parsed.data.expectedRevision ||
        lastItem?.role !== "interviewer" ||
        !session.transcript.slice(0, -1).some((item) => item.role === "candidate")
      ) {
        return NextResponse.json(
          { code: "NO_RETRYABLE_QUESTION", message: "当前没有可重新生成的追问" },
          { status: 409 }
        );
      }
      const question = await generateNextQuestion({
        roleName: session.roleName,
        jobDescription: session.jobDescription,
        interviewFocus: session.interviewFocus,
        transcript: session.transcript.slice(0, -1),
        knowledgeContext: await knowledgeContextFor(
          session.resumeIds,
          session.transcript.slice(0, -1),
          lastCandidateText(session.transcript.slice(0, -1))
        )
      });
      return NextResponse.json(await replaceLastInterviewerQuestion({
        question,
        expectedRevision: parsed.data.expectedRevision,
        expectedQuestionAt: lastItem.at
      }));
    }
    if (parsed.data.action === "correctLastAnswer") {
      const session = await getSession();
      const currentQuestion = session.transcript.at(-1);
      const currentAnswer = session.transcript.at(-2);
      if (
        session.status !== "running" ||
        currentAnswer?.role !== "candidate" ||
        currentQuestion?.role !== "interviewer"
      ) {
        return NextResponse.json(
          { code: "NO_CORRECTABLE_ANSWER", message: "当前没有可修正的最近回答" },
          { status: 409 }
        );
      }
      const correctedTranscript = [
        ...session.transcript.slice(0, -2),
        { ...currentAnswer, text: parsed.data.answer }
      ];
      const question = await generateNextQuestion({
        roleName: session.roleName,
        jobDescription: session.jobDescription,
        interviewFocus: session.interviewFocus,
        transcript: correctedTranscript,
        knowledgeContext: await knowledgeContextFor(session.resumeIds, correctedTranscript, parsed.data.answer)
      });
      return NextResponse.json(await replaceLastExchange({
        answer: parsed.data.answer,
        question,
        expectedAnswerAt: currentAnswer.at,
        expectedQuestionAt: currentQuestion.at
      }));
    }
    if (parsed.data.action === "generateReport") {
      const session = await getSession();
      if (session.status !== "finished") {
        return NextResponse.json(
          { code: "SESSION_RUNNING", message: "请先结束互动，再生成纪要" },
          { status: 409 }
        );
      }
      const report = await generateInterviewReport({
        roleName: session.roleName,
        jobDescription: session.jobDescription,
        interviewFocus: session.interviewFocus,
        transcript: session.transcript
      });
      return NextResponse.json(await setInterviewReport(report));
    }

    const session = await getSession();
    if (
      session.status !== "running" ||
      session.revision !== parsed.data.expectedRevision ||
      session.transcript.at(-1)?.role !== "interviewer"
    ) {
      console.warn(
        `[session] answer rejected code=SESSION_CHANGED sessionId=${session.sessionId} status=${session.status} ` +
          `revision=${session.revision} expected=${parsed.data.expectedRevision}`
      );
      return NextResponse.json(
        { code: "SESSION_CHANGED", message: "对话轮次已变化，请刷新后重试" },
        { status: 409 }
      );
    }
    if (hasReachedQuestionLimit(session)) {
      const finished = await appendFinalAnswerAndFinish({
        answer: parsed.data.answer,
        expectedRevision: parsed.data.expectedRevision
      });
      console.log(
        `[session] answer(final) sessionId=${session.sessionId} revision=${session.revision} elapsedMs=${Date.now() - startedAt}`
      );
      return NextResponse.json(finished);
    }
    const transcriptWithAnswer = [
      ...session.transcript,
      {
        role: "candidate" as const,
        text: parsed.data.answer,
        at: new Date().toISOString()
      }
    ];
    const question = await generateNextQuestion({
      roleName: session.roleName,
      jobDescription: session.jobDescription,
      interviewFocus: session.interviewFocus,
      transcript: transcriptWithAnswer,
      knowledgeContext: await knowledgeContextFor(session.resumeIds, session.transcript, parsed.data.answer)
    });
    const updated = await appendAnswerAndQuestion({
      answer: parsed.data.answer,
      question,
      expectedRevision: parsed.data.expectedRevision
    });
    console.log(
      `[session] answer ok sessionId=${session.sessionId} revision=${session.revision} elapsedMs=${Date.now() - startedAt}`
    );
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    console.warn(`[session] action failed action=${parsed.data.action} code=${message} elapsedMs=${Date.now() - startedAt}`);
    const missingKey = message === "MISSING_API_KEY";
    const noAnswers = message === "NO_CANDIDATE_ANSWERS";
    const modelTimeout = message === "MODEL_TIMEOUT";
    const invalidState = [
      "SESSION_NOT_RUNNING",
      "SESSION_ALREADY_RUNNING",
      "NO_RETRYABLE_QUESTION",
      "SESSION_CHANGED"
    ].includes(message);
    return NextResponse.json(
      {
        code: modelTimeout
          ? "MODEL_TIMEOUT"
          : missingKey
          ? "NOT_CONFIGURED"
          : noAnswers
            ? "NO_ANSWERS"
            : invalidState
              ? "INVALID_SESSION_STATE"
              : "MODEL_ERROR",
        message: modelTimeout
          ? "模型响应超时，请检查本机模型负载或网络后重试"
          : missingKey
          ? "请先在控制台配置远程模型密钥，或使用本机无密钥模型"
          : noAnswers
            ? "没有对方回答，无法生成纪要"
            : invalidState
              ? message === "SESSION_ALREADY_RUNNING"
                ? "请先结束当前互动，再开始新互动"
                : message === "SESSION_CHANGED"
                ? "会话已发生变化，请刷新后重试"
                : "当前会话状态不允许此操作"
              : "模型暂时无法完成本次操作"
      },
      {
        status: modelTimeout
          ? 504
          : missingKey
            ? 503
            : noAnswers
              ? 422
              : invalidState
                ? 409
                : 502
      }
    );
  }
}
