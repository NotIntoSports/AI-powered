import { NextResponse } from "next/server";
import { z } from "zod";
import {
  appendAnswerAndQuestion,
  appendInterviewerQuestion,
  finishSession,
  getSession,
  replaceLastExchange,
  replaceLastInterviewerQuestion,
  resetSession,
  setInterviewReport
} from "../../../lib/interview";
import { assistantRoleSchema } from "../../../lib/assistant-role";
import { getRoleProfile } from "../../../lib/role-profiles";
import { formatPipelineLog } from "../../../lib/pipeline-diagnostics";
import { modelReportSchema } from "../../../lib/interview-report";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    candidateName: z.string().trim().max(50),
    assistantRole: assistantRoleSchema,
    roleName: z.string().trim().max(100),
    jobDescription: z.string().trim().max(3000).default(""),
    interviewFocus: z.string().trim().max(500).default(""),
    consentConfirmed: z.boolean().default(false),
    resumeIds: z.array(z.string().trim().max(64)).max(20).optional().default([]),
    resumeId: z.string().trim().max(64).optional().default("")
  }),
  z.object({
    action: z.literal("answer"),
    answer: z.string().trim().min(1).max(4000),
    expectedRevision: z.number().int().nonnegative()
  }),
  z.object({
    action: z.literal("e2e_turn"),
    answer: z.string().trim().min(1).max(4000),
    question: z.string().trim().min(1).max(4000),
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
  z.object({ action: z.literal("generateReport") }),
  z.object({ action: z.literal("agentRetryResult"), question: z.string().trim().min(1).max(4000), expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("agentCorrectionResult"), answer: z.string().trim().min(1).max(4000), question: z.string().trim().min(1).max(4000), expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("agentReportResult"), report: modelReportSchema })
]);

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
      const roleProfile = await getRoleProfile(parsed.data.assistantRole);
      const started = await resetSession({ ...parsed.data, roleProfile });
      console.log(`[session] started sessionId=${started.sessionId} elapsedMs=${Date.now() - startedAt}`);
      console.log(formatPipelineLog({
        event: "session.started",
        traceId: started.sessionId,
        fields: { revision: started.revision, durationMs: Date.now() - startedAt, status: started.status }
      }));
      return NextResponse.json(started);
    }
    if (parsed.data.action === "say") {
      return NextResponse.json(await appendInterviewerQuestion(parsed.data.text, "manual"));
    }
    if (parsed.data.action === "finish") {
      return NextResponse.json(await finishSession());
    }
    if (parsed.data.action === "agentRetryResult") {
      const session = await getSession();
      const lastItem = session.transcript.at(-1);
      if (!lastItem || lastItem.role !== "interviewer") throw new Error("NO_RETRYABLE_QUESTION");
      return NextResponse.json(await replaceLastInterviewerQuestion({ question: parsed.data.question, expectedRevision: parsed.data.expectedRevision, expectedQuestionAt: lastItem.at }));
    }
    if (parsed.data.action === "agentCorrectionResult") {
      const session = await getSession();
      const question = session.transcript.at(-1);
      const answer = session.transcript.at(-2);
      if (!question || question.role !== "interviewer" || !answer || answer.role !== "candidate") throw new Error("NO_CORRECTABLE_ANSWER");
      return NextResponse.json(await replaceLastExchange({ answer: parsed.data.answer, question: parsed.data.question, expectedAnswerAt: answer.at, expectedQuestionAt: question.at }));
    }
    if (parsed.data.action === "agentReportResult") {
      return NextResponse.json(await setInterviewReport({ ...parsed.data.report, generatedAt: new Date().toISOString(), humanReviewRequired: true }));
    }
    if (["retryQuestion", "correctLastAnswer", "generateReport", "answer"].includes(parsed.data.action)) {
      return NextResponse.json(
        { code: "AGENT_ACTION_REQUIRED", message: "该操作必须由 LiveKit Agent 执行" },
        { status: 409 }
      );
    }

    if (parsed.data.action === "e2e_turn") {
      const session = await getSession();
      const updated = await appendAnswerAndQuestion({
        answer: parsed.data.answer,
        question: parsed.data.question,
        expectedRevision: parsed.data.expectedRevision
      });
      console.log(
        `[session] e2e_turn ok sessionId=${session.sessionId} revision=${updated.revision} elapsedMs=${Date.now() - startedAt}`
      );
      console.log(formatPipelineLog({
        event: "ai.succeeded",
        traceId: session.sessionId,
        fields: {
          revision: updated.revision,
          durationMs: Date.now() - startedAt,
          textLength: parsed.data.question.length,
          source: "livekit-e2e"
        }
      }));
      return NextResponse.json(updated);
    }

    return NextResponse.json({ code: "INVALID_INPUT", message: "不支持的操作" }, { status: 422 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    console.warn(`[session] action failed action=${parsed.data.action} code=${message} elapsedMs=${Date.now() - startedAt}`);
    const invalidState = [
      "SESSION_NOT_RUNNING",
      "SESSION_ALREADY_RUNNING",
      "NO_RETRYABLE_QUESTION",
      "NO_CORRECTABLE_ANSWER",
      "SESSION_CHANGED"
    ].includes(message);
    return NextResponse.json(
      {
        code: invalidState ? "INVALID_SESSION_STATE" : "SESSION_ERROR",
        message: invalidState
          ? message === "SESSION_ALREADY_RUNNING"
            ? "请先结束当前互动，再开始新互动"
            : message === "SESSION_CHANGED"
              ? "会话已发生变化，请刷新后重试"
              : "当前会话状态不允许此操作"
          : "会话操作暂时无法完成"
      },
      { status: invalidState ? 409 : 500 }
    );
  }
}
